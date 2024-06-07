import crypto from 'crypto';
import * as anchor from '@coral-xyz/anchor';
import { Program, web3, AnchorError } from '@coral-xyz/anchor';
import { Obridge } from '../target/types/obridge';
import {
    getAccount,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    getAssociatedTokenAddressSync,
    getOrCreateAssociatedTokenAccount,
    Account,
} from '@solana/spl-token';
import { keccak_256 } from '@noble/hashes/sha3';
import BN from 'bn.js';
import { createAccountOnChain, airdropSOL, createSPLTokenAndMintToUser, transferSOL } from './helper';
import { expect } from 'chai';

type Lock = {
    hash: Array<number>;
    deadline: BN;
};

describe('obridge swap', () => {
    // Configure the client to use the local cluster.
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const connection = provider.connection;
    console.log(`network connected: ${connection.rpcEndpoint}`);
    const program = anchor.workspace.Obridge as Program<Obridge>;
    console.log(`obridge program: ${program.programId}`);

    // create user and airdrop SOL
    const payer = web3.Keypair.generate();
    console.log(`payer: ${payer.publicKey}`);

    const admin = payer;
    console.log(`admin: ${admin.publicKey}`);

    let user: web3.Keypair;
    let tokenAmount: number;
    let solAmount: number;
    let mint1: web3.PublicKey;
    let mint1Settings: web3.PublicKey;
    let userAtaTokenMint1Account: Account;

    let lp: web3.Keypair;
    let tokenAmountBack: number;
    let solAmountBack: number;
    let mint2: web3.PublicKey;
    let mint2Settings: web3.PublicKey;
    let lpAtaTokenMint2Account: Account;

    let adminSettings: web3.PublicKey;
    let preimage: Array<number>;
    let relayPreimage: Array<number>;
    let agreementReachedTime: number;
    let stepTimelock: number;
    let hashlock: Array<number>;
    let relayHashlock: Array<number>;

    let feeRecepient: web3.Keypair;

    before(async () => {
        console.log(`========== setup up ==========`);
        await airdropSOL(connection, payer, 100 * 10 ** 9);
        const payerBal = await connection.getBalance(payer.publicKey);
        console.log(`payer ${payer.publicKey} balance: ${payerBal / web3.LAMPORTS_PER_SOL} SOL`);

        tokenAmount = 2 * 10 ** 9;
        solAmount = 2 * 10 ** 9;
        user = await createAccountOnChain(connection, payer);
        await transferSOL(connection, payer, user.publicKey, solAmount);
        const userBal = await connection.getBalance(user.publicKey);
        console.log(`user: ${user.publicKey} balance: ${userBal / web3.LAMPORTS_PER_SOL} SOL`);

        let ret = await createSPLTokenAndMintToUser(connection, payer, user, tokenAmount);
        mint1 = ret.mint;
        userAtaTokenMint1Account = ret.ataTokenAccount;
        [mint1Settings] = web3.PublicKey.findProgramAddressSync(
            [Buffer.from('token'), mint1.toBytes()],
            program.programId,
        );
        console.log(`offchain mint1Settings: ${mint1Settings.toBase58()}`);
        console.log(
            `create SPL token mint1 ${mint1} and user ${user.publicKey} ata account ${userAtaTokenMint1Account.address}`,
        );
        userAtaTokenMint1Account = await getAccount(connection, userAtaTokenMint1Account.address);
        console.log(
            `user ata token mint1 account ${userAtaTokenMint1Account.address} balance: ${userAtaTokenMint1Account.amount}`,
        );

        tokenAmountBack = 5 * 10 ** 9;
        solAmountBack = 5 * 10 ** 9;
        lp = await createAccountOnChain(connection, payer);
        await transferSOL(connection, payer, lp.publicKey, solAmountBack);
        const lpBal = await connection.getBalance(lp.publicKey);
        console.log(`lp: ${lp.publicKey} balance: ${lpBal / web3.LAMPORTS_PER_SOL} SOL`);

        ret = await createSPLTokenAndMintToUser(connection, payer, lp, tokenAmountBack);
        mint2 = ret.mint;
        lpAtaTokenMint2Account = ret.ataTokenAccount;
        [mint2Settings] = web3.PublicKey.findProgramAddressSync(
            [Buffer.from('token'), mint2.toBytes()],
            program.programId,
        );
        console.log(`offchain mint2Settings: ${mint2Settings.toBase58()}`);
        console.log(
            `create SPL token mint2 ${mint2} and lp ${lp.publicKey} ata account ${lpAtaTokenMint2Account.address}`,
        );
        lpAtaTokenMint2Account = await getAccount(connection, lpAtaTokenMint2Account.address);
        console.log(
            `lp ata token mint2 account ${lpAtaTokenMint2Account.address} balance: ${lpAtaTokenMint2Account.amount}`,
        );

        feeRecepient = web3.Keypair.generate();

        [adminSettings] = web3.PublicKey.findProgramAddressSync([Buffer.from('settings')], program.programId);
        console.log(`offchain adminSettings: ${adminSettings.toBase58()}`);

        let _preimage = new Uint8Array(32);
        preimage = Array.from(crypto.getRandomValues(_preimage));

        let _relayPreimage = new Uint8Array(32);
        relayPreimage = Array.from(crypto.getRandomValues(_relayPreimage));

        let slot = await connection.getSlot();
        agreementReachedTime = await connection.getBlockTime(slot);
        if (!agreementReachedTime) {
            throw new Error('agreementReachedTime is null');
        }
        console.log(`agreementReachedTime: ${agreementReachedTime}`);
        stepTimelock = 1;
        console.log(`stepTimelock: ${stepTimelock}`);

        hashlock = Array.from(keccak_256(Buffer.from(preimage)));
        relayHashlock = Array.from(keccak_256(Buffer.from(relayPreimage)));
    });

    it('SPL A_Token -> SPL B_Token swap', async () => {
        console.log(`========== transfer out ==========`);
        let _uuid1 = new Uint8Array(16);
        let uuid1 = Array.from(crypto.getRandomValues(_uuid1));
        console.log(`generate a random uuid1: ${uuid1}`);

        let lockUser: Lock = {
            hash: hashlock,
            deadline: new BN(agreementReachedTime + 3 * stepTimelock),
        };
        console.log(`lockUser: ${JSON.stringify(lockUser)}`);

        let lockRelay: Lock = {
            hash: relayHashlock,
            deadline: new BN(agreementReachedTime + 6 * stepTimelock),
        };
        console.log(`lockRelay: ${JSON.stringify(lockRelay)}`);

        // calculate escrow account address offchain without create it
        let [escrow1] = web3.PublicKey.findProgramAddressSync([Buffer.from(uuid1)], program.programId);
        console.log(`offchain escrow1: ${escrow1}`);

        // calculate escrowAtaTokenAccount account address offchain without create it
        let escrow1AtaTokenAccount = getAssociatedTokenAddressSync(mint1, escrow1, true);
        console.log(`offchain escrow1 ata ${escrow1AtaTokenAccount}`);

        let extraData = Buffer.from([1, 2, 3, 4, 5]);
        let memo = Buffer.from([1, 2, 3, 4, 5]);

        let transferOutDeadline = agreementReachedTime + 1 * stepTimelock;
        let refundDeadline = agreementReachedTime + 7 * stepTimelock;

        // got error before initialize program
        try {
            await program.methods
                .prepare(
                    uuid1,
                    lp.publicKey,
                    new BN(solAmount),
                    new BN(tokenAmount),
                    lockUser,
                    lockRelay,
                    new BN(transferOutDeadline),
                    new BN(refundDeadline),
                    extraData,
                    memo,
                )
                .accounts({
                    payer: payer.publicKey,
                    from: user.publicKey,
                    mint: mint1,
                    source: userAtaTokenMint1Account.address,
                    escrow: escrow1,
                    escrowAta: escrow1AtaTokenAccount,
                    adminSettings: adminSettings,
                    tokenSettings: null,
                    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                    systemProgram: web3.SystemProgram.programId,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([payer, user])
                .rpc();
        } catch (err) {
            console.log(`if program is not initialized, it should throw error`);
            console.log(`========== error ==========`);
            console.log((err as AnchorError).logs);
            expect((err as AnchorError).logs).not.to.be.empty;
        }

        // initialize program
        let tx = await program.methods
            .initialize(admin.publicKey)
            .accounts({
                payer: payer.publicKey,
                adminSettings: adminSettings,
                systemProgram: web3.SystemProgram.programId,
            })
            .signers([payer])
            .rpc();

        console.log(`initialize program tx: ${tx}`);

        // cannot initialize program again
        try {
            await program.methods
                .initialize(payer.publicKey)
                .accounts({
                    payer: admin.publicKey,
                    adminSettings: adminSettings,
                    systemProgram: web3.SystemProgram.programId,
                })
                .signers([payer])
                .rpc();
        } catch (err) {
            console.log(`if program is initialized and initialized again, it should throw error`);
            console.log(`========== error ==========`);
            console.log((err as AnchorError).logs);
            expect((err as AnchorError).logs).not.to.be.empty;
        }

        // transfer out
        tx = await program.methods
            .prepare(
                uuid1,
                lp.publicKey,
                new BN(solAmount),
                new BN(tokenAmount),
                lockUser,
                lockRelay,
                new BN(transferOutDeadline),
                new BN(refundDeadline),
                extraData,
                memo,
            )
            .accounts({
                payer: payer.publicKey,
                from: user.publicKey,
                mint: mint1,
                source: userAtaTokenMint1Account.address,
                escrow: escrow1,
                escrowAta: escrow1AtaTokenAccount,
                adminSettings: adminSettings,
                tokenSettings: null,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: web3.SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([payer, user])
            .rpc();

        console.log(`transfer out tx: ${tx}`);

        // try to use same uuid for wrong test
        try {
            await program.methods
                .prepare(
                    uuid1,
                    lp.publicKey,
                    new BN(solAmount),
                    new BN(tokenAmount),
                    lockUser,
                    lockRelay,
                    new BN(transferOutDeadline),
                    new BN(refundDeadline),
                    extraData,
                    memo,
                )
                .accounts({
                    payer: payer.publicKey,
                    from: user.publicKey,
                    mint: mint1,
                    source: userAtaTokenMint1Account.address,
                    escrow: escrow1,
                    escrowAta: escrow1AtaTokenAccount,
                    adminSettings: adminSettings,
                    tokenSettings: null,
                    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                    systemProgram: web3.SystemProgram.programId,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([payer, user])
                .rpc();
        } catch (err: any) {
            console.log(`if use same uuid, it should throw error`);
            console.log(`========== error ==========`);
            console.log((err as AnchorError).logs);
            expect((err as AnchorError).logs).not.to.be.empty;
        }

        console.log(`========== transfer in ==========`);
        let _uuid2 = new Uint8Array(16);
        let uuid2 = Array.from(crypto.getRandomValues(_uuid2));
        console.log(`generate a random uuid2: ${uuid2}`);

        let lockLp: Lock = {
            hash: hashlock,
            deadline: new BN(agreementReachedTime + 5 * stepTimelock),
        };
        console.log(`lockLp: ${JSON.stringify(lockLp)}`);

        let transferInDeadline = agreementReachedTime + 2 * stepTimelock;

        // calculate escrow account address offchain without create it
        let [escrow2] = web3.PublicKey.findProgramAddressSync([Buffer.from(uuid2)], program.programId);
        console.log(`offchain escrow2: ${escrow2}`);

        // calculate escrowAtaTokenAccount account address offchain without create it
        let escrow2AtaTokenAccount = getAssociatedTokenAddressSync(mint2, escrow2, true);
        console.log(`offchain escrow2 ata ${escrow2AtaTokenAccount}`);

        // lp response to the swap initiated by user (transfer in)
        const tx2 = await program.methods
            .prepare(
                uuid2,
                user.publicKey,
                new BN(solAmountBack),
                new BN(tokenAmountBack),
                lockLp,
                null,
                new BN(transferInDeadline),
                new BN(refundDeadline),
                extraData,
                memo,
            )
            .accounts({
                payer: payer.publicKey,
                from: lp.publicKey,
                mint: mint2,
                source: lpAtaTokenMint2Account.address,
                escrow: escrow2,
                escrowAta: escrow2AtaTokenAccount,
                adminSettings: adminSettings,
                tokenSettings: null,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: web3.SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([payer, lp])
            .rpc();

        console.log(`transfer in tx: ${tx2}`);

        console.log(`========== confirm transfer out ==========`);

        // set fee recepient
        tx = await program.methods
            .setFeeRecepient()
            .accounts({
                admin: admin.publicKey,
                feeRecepient: feeRecepient.publicKey,
                adminSettings: adminSettings,
            })
            .signers([payer, feeRecepient])
            .rpc();

        console.log(`set fee recepient tx: ${tx}`);

        // set fee rate to 10%
        tx = await program.methods
            .setFeeRate(1000)
            .accounts({
                admin: admin.publicKey,
                adminSettings: adminSettings,
            })
            .signers([payer])
            .rpc();

        console.log(`set fee rate tx: ${tx}`);

        // lp token mint1 ata address
        let lpAtaTokenMint1Account = await getOrCreateAssociatedTokenAccount(connection, payer, mint1, lp.publicKey);

        // fee recepient mint1 ata address
        let feeDestination = await getOrCreateAssociatedTokenAccount(connection, payer, mint1, feeRecepient.publicKey);

        // user confirm the swap (transfer out)
        const tx3 = await program.methods
            .confirm(uuid1, relayPreimage)
            .accounts({
                to: lp.publicKey,
                destination: lpAtaTokenMint1Account.address,
                escrow: escrow1,
                escrowAta: escrow1AtaTokenAccount,
                adminSettings: adminSettings,
                feeRecepient: feeRecepient.publicKey,
                feeDestination: feeDestination.address,
                systemProgram: web3.SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .rpc();

        console.log(`confirm transfer out tx: ${tx3}`);

        // console.log(`========== confirm transfer in ==========`);
        // // user token mint2 ata address
        // let userAtaTokenMint2Account = await getOrCreateAssociatedTokenAccount(
        //     connection,
        //     payer,
        //     mint2,
        //     user.publicKey,
        // );
        // // lp confirm the swap (transfer in)
        // const tx4 = await program.methods
        //     .confirm(uuid2, preimage)
        //     .accounts({
        //         destination: userAtaTokenMint2Account.address,
        //         escrow: escrow2,
        //         escrowAta: escrow2AtaTokenAccount,
        //         systemProgram: web3.SystemProgram.programId,
        //         tokenProgram: TOKEN_PROGRAM_ID,
        //     })
        //     .rpc();

        // console.log(`confirm transfer in tx: ${tx4}`);
    });

    // it('cannot call initiate after deadline', async () => {
    //     let _uuid1 = new Uint8Array(16);
    //     let uuid1 = Array.from(crypto.getRandomValues(_uuid1));
    //     console.log(`generate a random uuid1: ${uuid1}`);

    //     let lockUser: Lock = {
    //         hash: hashlock,
    //         deadline: new BN(agreementReachedTime + 3 * stepTimelock),
    //     };
    //     console.log(`lockUser: ${JSON.stringify(lockUser)}`);

    //     let lockRelay: Lock = {
    //         hash: relayHashlock,
    //         deadline: new BN(agreementReachedTime + 6 * stepTimelock),
    //     };
    //     console.log(`lockRelay: ${JSON.stringify(lockRelay)}`);

    //     // calculate escrow account address offchain without create it
    //     let [escrow1] = web3.PublicKey.findProgramAddressSync([Buffer.from(uuid1)], program.programId);
    //     console.log(`offchain escrow1: ${escrow1}`);

    //     // calculate escrowAtaTokenAccount account address offchain without create it
    //     let escrow1AtaTokenAccount = getAssociatedTokenAddressSync(mint1, escrow1, true);
    //     console.log(`offchain escrow1 ata ${escrow1AtaTokenAccount}`);

    //     let extraData = Buffer.from([1, 2, 3, 4, 5]);

    //     let transferOutDeadline = agreementReachedTime + 1 * stepTimelock;
    //     let refundDeadline = agreementReachedTime + 7 * stepTimelock;

    //     // sleep until the transfer out deadline
    //     await sleep(2000);

    //     try {
    //         await program.methods
    //             .initiate(
    //                 uuid1,
    //                 lp.publicKey,
    //                 new BN(amount),
    //                 lockUser,
    //                 lockRelay,
    //                 new BN(transferOutDeadline),
    //                 new BN(refundDeadline),
    //                 extraData,
    //             )
    //             .accounts({
    //                 payer: payer.publicKey,
    //                 from: user.publicKey,
    //                 mint: mint1,
    //                 source: userAtaTokenMint1Account.address,
    //                 escrow: escrow1,
    //                 escrowAta: escrow1AtaTokenAccount,
    //                 associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    //                 systemProgram: web3.SystemProgram.programId,
    //                 tokenProgram: TOKEN_PROGRAM_ID,
    //             })
    //             .signers([payer, user])
    //             .rpc();
    //     } catch (err: any) {
    //         expect((err as AnchorError).error.errorCode.code).to.be.eq('DeadlineExceeded');
    //         expect((err as AnchorError).error.errorCode.number).to.be.eq(6006);
    //     }
    // });

    // it("cannot call initiate with amount 0", async () => {
    //     let _uuid1 = new Uint8Array(16);
    //     let uuid1 = Array.from(crypto.getRandomValues(_uuid1));
    //     console.log(`generate a random uuid1: ${uuid1}`);

    //     let lockUser: Lock = {
    //         hash: hashlock,
    //         deadline: new BN(agreementReachedTime + 3 * stepTimelock)
    //     }
    //     console.log(`lockUser: ${JSON.stringify(lockUser)}`);

    //     let lockRelay: Lock = {
    //         hash: relayHashlock,
    //         deadline: new BN(agreementReachedTime + 6 * stepTimelock)
    //     }
    //     console.log(`lockRelay: ${JSON.stringify(lockRelay)}`);

    //     // calculate escrow account address offchain without create it
    //     let [escrow1,] = web3.PublicKey.findProgramAddressSync([Buffer.from(uuid1)], program.programId);
    //     console.log(`offchain escrow1: ${escrow1}`);

    //     // calculate escrowAtaTokenAccount account address offchain without create it
    //     let escrow1AtaTokenAccount = getAssociatedTokenAddressSync(mint1, escrow1, true);
    //     console.log(`offchain escrow1 ata ${escrow1AtaTokenAccount}`);

    //     let extraData = Buffer.from([1, 2, 3, 4, 5]);

    //     let transferOutDeadline = agreementReachedTime + 1 * stepTimelock;
    //     let refundDeadline = agreementReachedTime + 7 * stepTimelock;

    //     // sleep until the transfer out deadline
    //     await sleep(2000);

    //     try {
    //         await program.methods
    //             .initiate(
    //                 uuid1,
    //                 lp.publicKey,
    //                 new BN(0),
    //                 lockUser,
    //                 lockRelay,
    //                 new BN(transferOutDeadline),
    //                 new BN(refundDeadline),
    //                 extraData
    //             )
    //             .accounts({
    //                 payer: payer.publicKey,
    //                 from: user.publicKey,
    //                 mint: mint1,
    //                 source: userAtaTokenMint1Account.address,
    //                 escrow: escrow1,
    //                 escrowAta: escrow1AtaTokenAccount,
    //                 associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    //                 systemProgram: web3.SystemProgram.programId,
    //                 tokenProgram: TOKEN_PROGRAM_ID,
    //             })
    //             .signers([payer, user])
    //             .rpc();
    //     } catch (err: any) {
    //         expect((err as AnchorError).error.errorCode.code).to.be.eq("InvalidAmount");
    //         expect((err as AnchorError).error.errorCode.number).to.be.eq(6003);
    //     }
    // });
});

// describe("obridge refund", () => {

//     // Configure the client to use the local cluster.
//     const provider = anchor.AnchorProvider.env();
//     anchor.setProvider(provider);

//     const connection = provider.connection;
//     console.log(`network connected: ${connection.rpcEndpoint}`);
//     const program = anchor.workspace.Obridge as Program<Obridge>;
//     console.log(`obridge program: ${program.programId}`);

//     // create user and airdrop SOL
//     const payer = web3.Keypair.generate();
//     console.log(`payer: ${payer.publicKey}`);

//     beforeEach(async () => {
//         console.log(`obridge refund before each`);
//     });

//     it("SPL A_Token -> SPL B_Token refund", async () => {

//         console.log(`========== setup up ==========`);
//         await airdropSOL(connection, payer, 10 * 10 ** 9);
//         const payerBal = await connection.getBalance(payer.publicKey);
//         console.log(`payer ${payer.publicKey} balance: ${payerBal / web3.LAMPORTS_PER_SOL} SOL`);

//         const user = await createAccountOnChain(connection, payer);
//         console.log(`user: ${user.publicKey}`);

//         const amount = 2 * 10 ** 9;
//         let { mint: mint1, ataTokenAccount: userAtaTokenMint1Account } = await createSPLTokenAndMintToUser(connection, payer, user, amount);
//         console.log(`create SPL token mint1 ${mint1} and user ${user.publicKey} ata account ${userAtaTokenMint1Account.address}`);
//         userAtaTokenMint1Account = await getAccount(
//             connection,
//             userAtaTokenMint1Account.address
//         );
//         console.log(`user ata token mint1 account ${userAtaTokenMint1Account.address} balance: ${userAtaTokenMint1Account.amount}`);

//         const lp = await createAccountOnChain(connection, payer);
//         console.log(`lp: ${lp.publicKey}`);
//         const amountBack = 5 * 10 ** 9;
//         let { mint: mint2, ataTokenAccount: lpAtaTokenMint2Account } = await createSPLTokenAndMintToUser(connection, payer, lp, amountBack);
//         console.log(`create SPL token mint2 ${mint2} and lp ${lp.publicKey} ata account ${lpAtaTokenMint2Account.address}`);
//         lpAtaTokenMint2Account = await getAccount(
//             connection,
//             lpAtaTokenMint2Account.address
//         );
//         console.log(`lp ata token mint2 account ${lpAtaTokenMint2Account.address} balance: ${lpAtaTokenMint2Account.amount}`);

//         let _preimage = new Uint8Array(32);
//         let preimage = Array.from(crypto.getRandomValues(_preimage));

//         let _relayPreimage = new Uint8Array(32);
//         let relayPreimage = Array.from(crypto.getRandomValues(_relayPreimage));

//         let slot = await connection.getSlot();
//         let agreementReachedTime = await connection.getBlockTime(slot);
//         if (!agreementReachedTime) {
//             throw new Error("agreementReachedTime is null");
//         }
//         console.log(`agreementReachedTime: ${agreementReachedTime}`);
//         let stepTimelock = 1;
//         console.log(`stepTimelock: ${stepTimelock}`);

//         let hashlock = Array.from(keccak_256(Buffer.from(preimage)));
//         let relayHashlock = Array.from(keccak_256(Buffer.from(relayPreimage)));

//         console.log(`========== transfer out ==========`);
//         let _uuid1 = new Uint8Array(16);
//         let uuid1 = Array.from(crypto.getRandomValues(_uuid1));
//         console.log(`generate a random uuid1: ${uuid1}`);

//         let lockUser: Lock = {
//             hash: hashlock,
//             deadline: new BN(agreementReachedTime + 3 * stepTimelock)
//         }
//         console.log(`lockUser: ${JSON.stringify(lockUser)}`);

//         let lockRelay: Lock = {
//             hash: relayHashlock,
//             deadline: new BN(agreementReachedTime + 6 * stepTimelock)
//         }
//         console.log(`lockRelay: ${JSON.stringify(lockRelay)}`);

//         // calculate escrow account address offchain without create it
//         let [escrow1,] = web3.PublicKey.findProgramAddressSync([Buffer.from(uuid1)], program.programId);
//         console.log(`offchain escrow1: ${escrow1}`);

//         // calculate escrowAtaTokenAccount account address offchain without create it
//         let escrow1AtaTokenAccount = getAssociatedTokenAddressSync(mint1, escrow1, true);
//         console.log(`offchain escrow1 ata ${escrow1AtaTokenAccount}`);

//         let extraData = Buffer.from([1, 2, 3, 4, 5]);

//         let transferOutDeadline = agreementReachedTime + 1 * stepTimelock;
//         let refundDeadline = agreementReachedTime + 7 * stepTimelock;

//         // user initiate the swap (transfer out)
//         const tx = await program.methods
//             .initiate(
//                 uuid1,
//                 lp.publicKey,
//                 new BN(amount),
//                 lockUser,
//                 lockRelay,
//                 new BN(transferOutDeadline),
//                 new BN(refundDeadline),
//                 extraData
//             )
//             .accounts({
//                 payer: payer.publicKey,
//                 from: user.publicKey,
//                 mint: mint1,
//                 source: userAtaTokenMint1Account.address,
//                 escrow: escrow1,
//                 escrowAta: escrow1AtaTokenAccount,
//                 associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
//                 systemProgram: web3.SystemProgram.programId,
//                 tokenProgram: TOKEN_PROGRAM_ID,
//             })
//             .signers([payer, user])
//             .rpc();

//         console.log(`transfer out tx: ${tx}`);

//         console.log(`========== transfer in ==========`);
//         let _uuid2 = new Uint8Array(16);
//         let uuid2 = Array.from(crypto.getRandomValues(_uuid2));
//         console.log(`generate a random uuid2: ${uuid2}`);

//         let lockLp: Lock = {
//             hash: hashlock,
//             deadline: new BN(agreementReachedTime + 5 * stepTimelock)
//         }
//         console.log(`lockLp: ${JSON.stringify(lockLp)}`);

//         let transferInDeadline = agreementReachedTime + 2 * stepTimelock;

//         // calculate escrow account address offchain without create it
//         let [escrow2,] = web3.PublicKey.findProgramAddressSync([Buffer.from(uuid2)], program.programId);
//         console.log(`offchain escrow2: ${escrow2}`);

//         // calculate escrowAtaTokenAccount account address offchain without create it
//         let escrow2AtaTokenAccount = getAssociatedTokenAddressSync(mint2, escrow2, true);
//         console.log(`offchain escrow2 ata ${escrow2AtaTokenAccount}`);

//         // lp response to the swap initiated by user (transfer in)
//         const tx2 = await program.methods
//             .initiate(
//                 uuid2,
//                 user.publicKey,
//                 new BN(amountBack),
//                 lockLp,
//                 null,
//                 new BN(transferInDeadline),
//                 new BN(refundDeadline),
//                 extraData
//             )
//             .accounts({
//                 payer: payer.publicKey,
//                 from: lp.publicKey,
//                 mint: mint2,
//                 source: lpAtaTokenMint2Account.address,
//                 escrow: escrow2,
//                 escrowAta: escrow2AtaTokenAccount,
//                 associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
//                 systemProgram: web3.SystemProgram.programId,
//                 tokenProgram: TOKEN_PROGRAM_ID,
//             })
//             .signers([payer, lp])
//             .rpc();

//         console.log(`transfer in tx: ${tx2}`);

//         console.log(`========== refund transfer out ==========`);
//         try {
//             // if user refund the swap before the agreement reached time + 6 * stepTimelock, it should throw error
//             await program.methods
//                 .refund(
//                     uuid1
//                 )
//                 .accounts({
//                     source: userAtaTokenMint1Account.address,
//                     escrow: escrow1,
//                     escrowAta: escrow1AtaTokenAccount,
//                     systemProgram: web3.SystemProgram.programId,
//                     tokenProgram: TOKEN_PROGRAM_ID,
//                 })
//                 .rpc();
//         } catch (err: any) {
//             expect((err as AnchorError).error.errorCode.code).to.be.eq("NotRefundable");
//             expect((err as AnchorError).error.errorCode.number).to.be.eq(6008);
//         }
//         console.log(`wait until the agreement reached time + 7 * stepTimelock: ${agreementReachedTime + 7 * stepTimelock}`);
//         while (true) {
//             let slot = await connection.getSlot();
//             let currentTime = await connection.getBlockTime(slot);
//             if (!currentTime) {
//                 throw new Error("currentTime is null");
//             }
//             console.log(`currentTime: ${currentTime}`);
//             if (currentTime > agreementReachedTime + 7 * stepTimelock) {
//                 break;
//             }
//             await sleep(1000);
//         }

//         // user refund the swap (transfer out)
//         const tx5 = await program.methods
//             .refund(
//                 uuid1
//             )
//             .accounts({
//                 source: userAtaTokenMint1Account.address,
//                 escrow: escrow1,
//                 escrowAta: escrow1AtaTokenAccount,
//                 systemProgram: web3.SystemProgram.programId,
//                 tokenProgram: TOKEN_PROGRAM_ID,
//             })
//             .rpc();

//         console.log(`user refund transfer out tx: ${tx5}`);

//         console.log(`========== refund transfer in ==========`);
//         // lp refund the swap (transfer in)
//         const tx6 = await program.methods
//             .refund(
//                 uuid2
//             )
//             .accounts({
//                 source: lpAtaTokenMint2Account.address,
//                 escrow: escrow2,
//                 escrowAta: escrow2AtaTokenAccount,
//                 systemProgram: web3.SystemProgram.programId,
//                 tokenProgram: TOKEN_PROGRAM_ID,
//             })
//             .rpc();

//         console.log(`lp refund transfer in tx: ${tx6}`);
//     })
// });
