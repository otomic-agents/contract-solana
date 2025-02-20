import crypto from "crypto";
import * as anchor from "@coral-xyz/anchor";
import { Program, web3, AnchorError } from "@coral-xyz/anchor";
import { Obridge } from "../target/types/obridge";
import {
    getAccount,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    getAssociatedTokenAddressSync,
    getOrCreateAssociatedTokenAccount,
    Account,
} from "@solana/spl-token";
import { keccak_256 } from "@noble/hashes/sha3";
import BN from "bn.js";
import {
    createAccountOnChain,
    airdropSOL,
    createSPLTokenAndMintToUser,
    transferSOL,
    sleep,
    splTokensBalance,
    generateUuid,
} from "./helper";
import { expect } from "chai";

type Lock = {
    hash: Array<number>;
    agreementReachedTime: BN;
    expectedSingleStepTime: BN;
    tolerantSingleStepTime: BN;
    earliestRefundTime: BN;
};

describe("OBridge", () => {
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

    const admin = web3.Keypair.generate();
    console.log(`admin: ${admin.publicKey}`);

    const newAdmin = web3.Keypair.generate();
    console.log(`new admin: ${newAdmin.publicKey}`);

    let feeRecepient = web3.Keypair.generate();
    console.log(`feeRecepient: ${feeRecepient.publicKey}`);

    let user: web3.Keypair;
    let tokenAmount: BN;
    let solAmount: BN;
    let mint1: web3.PublicKey;
    let mint1Settings: web3.PublicKey;
    let userAtaTokenMint1Account: Account;

    let lp: web3.Keypair;
    let tokenAmountBack: BN;
    let solAmountBack: BN;
    let mint2: web3.PublicKey;
    let mint2Settings: web3.PublicKey;
    let lpAtaTokenMint2Account: Account;

    let adminSettings: web3.PublicKey;
    let preimage: Array<number>;
    let hashlock: Array<number>;

    let isOut: boolean;
    let isIn: boolean;

    let tx: string;

    beforeEach(async () => {
        console.log(`========== setup up ==========`);
        await airdropSOL(connection, payer, 1000 * 10 ** 9);
        const payerBal = await connection.getBalance(payer.publicKey);
        console.log(`payer ${payer.publicKey} balance: ${payerBal / web3.LAMPORTS_PER_SOL} SOL`);

        tokenAmount = new BN(2 * 10 ** 9);
        solAmount = new BN(0);
        user = await createAccountOnChain(connection, payer);
        await transferSOL(connection, payer, user.publicKey, 20 * 10 ** 9);
        const userBal = await connection.getBalance(user.publicKey);
        console.log(`user: ${user.publicKey} balance: ${userBal / web3.LAMPORTS_PER_SOL} SOL`);

        let ret = await createSPLTokenAndMintToUser(connection, payer, user, tokenAmount.toNumber());
        mint1 = ret.mint;
        userAtaTokenMint1Account = ret.ataTokenAccount;
        [mint1Settings] = web3.PublicKey.findProgramAddressSync(
            [Buffer.from("token"), mint1.toBytes()],
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

        tokenAmountBack = new BN(5 * 10 ** 9);
        solAmountBack = new BN(5 * 10 ** 9);
        lp = await createAccountOnChain(connection, payer);
        await transferSOL(connection, payer, lp.publicKey, 20 * 10 ** 9);
        const lpBal = await connection.getBalance(lp.publicKey);
        console.log(`lp: ${lp.publicKey} balance: ${lpBal / web3.LAMPORTS_PER_SOL} SOL`);

        ret = await createSPLTokenAndMintToUser(connection, payer, lp, tokenAmountBack.toNumber());
        mint2 = ret.mint;
        lpAtaTokenMint2Account = ret.ataTokenAccount;
        [mint2Settings] = web3.PublicKey.findProgramAddressSync(
            [Buffer.from("token"), mint2.toBytes()],
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

        [adminSettings] = web3.PublicKey.findProgramAddressSync([Buffer.from("settings")], program.programId);
        console.log(`offchain adminSettings: ${adminSettings.toBase58()}`);

        let _preimage = new Uint8Array(32);
        preimage = Array.from(crypto.getRandomValues(_preimage));
        hashlock = Array.from(keccak_256(Buffer.from(preimage)));

        isOut = true;
        isIn = false;
    });

    it("swap SPL A Token <-> SPL B Token + SOL", async () => {
        let userMint1BalBefore = new BN(userAtaTokenMint1Account.amount.toString());
        let userMint2BalBefore = new BN(0);
        let userSOLBalBefore = new BN(await connection.getBalance(user.publicKey));

        let lpMint1BalBefore = new BN(0);
        let lpMint2BalBefore = new BN(lpAtaTokenMint2Account.amount.toString());
        let lpSOLBalBefore = new BN(await connection.getBalance(lp.publicKey));

        let feeRecepientMint1BalBefore = new BN(0);
        let feeRecepientMint2BalBefore = new BN(0);
        let feeRecepientSOLBalBefore = new BN(await connection.getBalance(feeRecepient.publicKey));

        let slot = await connection.getSlot();
        let agreementReachedTime = await connection.getBlockTime(slot);
        if (!agreementReachedTime) {
            throw new Error("agreementReachedTime is null");
        }

        let expectedSingleStepTime = 5;
        let tolerantSingleStepTime = 10;

        let lock: Lock = {
            hash: hashlock,
            agreementReachedTime: new BN(agreementReachedTime),
            expectedSingleStepTime: new BN(expectedSingleStepTime),
            tolerantSingleStepTime: new BN(tolerantSingleStepTime),
            earliestRefundTime: new BN(
                agreementReachedTime + 3 * expectedSingleStepTime + 3 * tolerantSingleStepTime + 1,
            ),
        };
        console.log(`lock: ${JSON.stringify(lock)}`);

        console.log(`========== transfer out ==========`);
        let uuid1 = generateUuid(
            user.publicKey,
            lp.publicKey,
            lock.hash,
            lock.agreementReachedTime,
            lock.expectedSingleStepTime,
            lock.tolerantSingleStepTime,
            lock.earliestRefundTime,
            mint1,
            tokenAmount,
            solAmount,
        );
        console.log(`generate uuid1: ${uuid1}`);

        // calculate escrow account address offchain without create it
        let [escrow1] = web3.PublicKey.findProgramAddressSync([Buffer.from(uuid1)], program.programId);
        console.log(`offchain escrow1: ${escrow1}`);

        // calculate escrowAtaTokenAccount account address offchain without create it
        let escrow1AtaTokenAccount = getAssociatedTokenAddressSync(mint1, escrow1, true);
        console.log(`offchain escrow1 ata ${escrow1AtaTokenAccount}`);

        let memo = Buffer.from([1, 2, 3, 4, 5]);

        // got error before initialize program
        try {
            await program.methods
                .prepare(uuid1, lp.publicKey, solAmount, tokenAmount, lock, isOut, memo)
                .accounts({
                    payer: user.publicKey,
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
                .signers([user])
                .rpc();
        } catch (err) {
            console.log(`if program is not initialized, it should throw error`);
            console.log(`========== error ==========`);
            console.log((err as AnchorError).logs);
            expect((err as AnchorError).logs).not.to.be.empty;
        }

        // initialize program
        tx = await program.methods
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
                .initialize(newAdmin.publicKey)
                .accounts({
                    payer: payer.publicKey,
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

        // use changeAdmin to change admin
        tx = await program.methods
            .changeAdmin()
            .accounts({
                admin: admin.publicKey,
                newAdmin: newAdmin.publicKey,
                adminSettings: adminSettings,
            })
            .signers([admin, newAdmin])
            .rpc();
        console.log(`change admin tx: ${tx}`);

        console.log(`========== set fee ==========`);
        // set fee recepient
        tx = await program.methods
            .setFeeRecepient()
            .accounts({
                admin: newAdmin.publicKey,
                feeRecepient: feeRecepient.publicKey,
                adminSettings: adminSettings,
            })
            .signers([newAdmin, feeRecepient])
            .rpc();

        console.log(`set fee recepient tx: ${tx}`);

        // set fee rate to 10%
        tx = await program.methods
            .setFeeRate(1000)
            .accounts({
                admin: newAdmin.publicKey,
                adminSettings: adminSettings,
            })
            .signers([newAdmin])
            .rpc();

        console.log(`set fee rate tx: ${tx}`);

        let feeMint1 = tokenAmount.mul(new BN(1000)).div(new BN(10000));
        let feeMint2 = tokenAmountBack.mul(new BN(1000)).div(new BN(10000));
        let feeSOL = solAmountBack.mul(new BN(1000)).div(new BN(10000));

        // transfer out
        tx = await program.methods
            .prepare(uuid1, lp.publicKey, solAmount, tokenAmount, lock, isOut, memo)
            .accounts({
                payer: user.publicKey,
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
            .signers([user])
            .rpc();

        console.log(`transfer out tx: ${tx}`);

        // try to use same uuid for wrong test
        try {
            await program.methods
                .prepare(uuid1, lp.publicKey, solAmount, tokenAmount, lock, isOut, memo)
                .accounts({
                    payer: user.publicKey,
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
                .signers([user])
                .rpc();
        } catch (err: any) {
            console.log(`if use same uuid, it should throw error`);
            console.log(`========== error ==========`);
            console.log((err as AnchorError).logs);
            expect((err as AnchorError).logs).not.to.be.empty;
        }

        console.log(`========== transfer in ==========`);
        let uuid2 = generateUuid(
            lp.publicKey,
            user.publicKey,
            lock.hash,
            lock.agreementReachedTime,
            lock.expectedSingleStepTime,
            lock.tolerantSingleStepTime,
            lock.earliestRefundTime,
            mint2,
            tokenAmountBack,
            solAmountBack,
        );
        console.log(`generate uuid2: ${uuid2}`);

        // calculate escrow account address offchain without create it
        let [escrow2] = web3.PublicKey.findProgramAddressSync([Buffer.from(uuid2)], program.programId);
        console.log(`offchain escrow2: ${escrow2}`);

        // calculate escrowAtaTokenAccount account address offchain without create it
        let escrow2AtaTokenAccount = getAssociatedTokenAddressSync(mint2, escrow2, true);
        console.log(`offchain escrow2 ata ${escrow2AtaTokenAccount}`);

        // lp response to the swap initiated by user (transfer in)
        const tx2 = await program.methods
            .prepare(uuid2, user.publicKey, solAmountBack, tokenAmountBack, lock, isIn, memo)
            .accounts({
                payer: lp.publicKey,
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
            .signers([lp])
            .rpc();

        console.log(`transfer in tx: ${tx2}`);

        console.log(`========== confirm transfer out ==========`);

        // set fee rate to 20% will not affect the fee at current swap
        tx = await program.methods
            .setFeeRate(2000)
            .accounts({
                admin: newAdmin.publicKey,
                adminSettings: adminSettings,
            })
            .signers([newAdmin])
            .rpc();

        console.log(`update fee rate in the middle of swap: ${tx}`);

        // lp token mint1 ata address
        let lpAtaTokenMint1Account = await getOrCreateAssociatedTokenAccount(connection, payer, mint1, lp.publicKey);

        // fee recepient mint1 ata address
        let feeMin1Destination = await getOrCreateAssociatedTokenAccount(
            connection,
            payer,
            mint1,
            feeRecepient.publicKey,
        );

        // user confirm the swap (transfer out)
        const tx3 = await program.methods
            .confirm(uuid1, preimage, isOut)
            .accounts({
                payer: user.publicKey,
                from: user.publicKey,
                to: lp.publicKey,
                destination: lpAtaTokenMint1Account.address,
                escrow: escrow1,
                escrowAta: escrow1AtaTokenAccount,
                adminSettings: adminSettings,
                feeRecepient: feeRecepient.publicKey,
                feeDestination: feeMin1Destination.address,
                systemProgram: web3.SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([user])
            .rpc();

        console.log(`confirm transfer out tx: ${tx3}`);

        console.log(`========== confirm transfer in ==========`);
        // user token mint2 ata address
        let userAtaTokenMint2Account = await getOrCreateAssociatedTokenAccount(
            connection,
            payer,
            mint2,
            user.publicKey,
        );

        // fee recepient mint2 ata address
        let feeMin2Destination = await getOrCreateAssociatedTokenAccount(
            connection,
            payer,
            mint2,
            feeRecepient.publicKey,
        );

        // lp confirm the swap (transfer in)
        const tx4 = await program.methods
            .confirm(uuid2, preimage, isIn)
            .accounts({
                payer: lp.publicKey,
                from: lp.publicKey,
                to: user.publicKey,
                destination: userAtaTokenMint2Account.address,
                escrow: escrow2,
                escrowAta: escrow2AtaTokenAccount,
                adminSettings: adminSettings,
                feeRecepient: feeRecepient.publicKey,
                feeDestination: feeMin2Destination.address,
                systemProgram: web3.SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([lp])
            .rpc();

        console.log(`confirm transfer in tx: ${tx4}`);

        let userMint1BalAfter = new BN(
            (await getAccount(connection, userAtaTokenMint1Account.address)).amount.toString(),
        );
        let userMint2BalAfter = new BN(
            (await getAccount(connection, userAtaTokenMint2Account.address)).amount.toString(),
        );
        let userSOLBalAfter = new BN(await connection.getBalance(user.publicKey));
        expect(userMint1BalBefore.sub(userMint1BalAfter).toString()).to.be.eq(tokenAmount.toString());
        expect(userMint2BalAfter.sub(userMint2BalBefore).toString()).to.be.eq(tokenAmountBack.sub(feeMint2).toString());
        expect(userSOLBalAfter.sub(userSOLBalBefore).toNumber()).to.be.eq(solAmountBack.sub(feeSOL).toNumber());

        let lpMint1BalAfter = new BN((await getAccount(connection, lpAtaTokenMint1Account.address)).amount.toString());
        let lpMint2BalAfter = new BN((await getAccount(connection, lpAtaTokenMint2Account.address)).amount.toString());
        let lpSOLBalAfter = new BN(await connection.getBalance(lp.publicKey));
        expect(lpMint1BalAfter.sub(lpMint1BalBefore).toString()).to.be.eq(tokenAmount.sub(feeMint1).toString());
        expect(lpMint2BalBefore.sub(lpMint2BalAfter).toString()).to.be.eq(tokenAmountBack.toString());
        expect(lpSOLBalBefore.sub(lpSOLBalAfter).toNumber()).to.be.eq(solAmountBack.toNumber());

        let feeRecepientMint1BalAfter = new BN(
            (await getAccount(connection, feeMin1Destination.address)).amount.toString(),
        );
        let feeRecepientMint2BalAfter = new BN(
            (await getAccount(connection, feeMin2Destination.address)).amount.toString(),
        );
        let feeRecepientSOLBalAfter = new BN(await connection.getBalance(feeRecepient.publicKey));
        expect(feeRecepientMint1BalAfter.sub(feeRecepientMint1BalBefore).toString()).to.be.eq(feeMint1.toString());
        expect(feeRecepientMint2BalAfter.sub(feeRecepientMint2BalBefore).toString()).to.be.eq(feeMint2.toString());
        expect(feeRecepientSOLBalAfter.sub(feeRecepientSOLBalBefore).toString()).to.be.eq(feeSOL.toString());
    });

    it("swap SOL <-> SOL", async () => {
        let userSOLBalBefore = new BN(await connection.getBalance(user.publicKey));
        let lpSOLBalBefore = new BN(await connection.getBalance(lp.publicKey));
        let feeRecepientSOLBalBefore = new BN(await connection.getBalance(feeRecepient.publicKey));

        let slot = await connection.getSlot();
        let agreementReachedTime = await connection.getBlockTime(slot);
        if (!agreementReachedTime) {
            throw new Error("agreementReachedTime is null");
        }

        let expectedSingleStepTime = 5;
        let tolerantSingleStepTime = 10;

        let lock: Lock = {
            hash: hashlock,
            agreementReachedTime: new BN(agreementReachedTime),
            expectedSingleStepTime: new BN(expectedSingleStepTime),
            tolerantSingleStepTime: new BN(tolerantSingleStepTime),
            earliestRefundTime: new BN(
                agreementReachedTime + 3 * expectedSingleStepTime + 3 * tolerantSingleStepTime + 1,
            ),
        };
        console.log(`lock: ${JSON.stringify(lock)}`);

        const ZERO_PUBKEY = new web3.PublicKey(new Uint8Array(32).fill(0));
        const fakeMint = ZERO_PUBKEY;
        const solAmount1 = new BN(2 * 10 ** 9);
        const tokenAmount1 = new BN(0);
        // set fee rate to 20% already in previous test
        const feeSOL = solAmount1.mul(new BN(2000)).div(new BN(10000));

        console.log(`========== transfer out ==========`);
        let uuid1 = generateUuid(
            user.publicKey,
            lp.publicKey,
            lock.hash,
            lock.agreementReachedTime,
            lock.expectedSingleStepTime,
            lock.tolerantSingleStepTime,
            lock.earliestRefundTime,
            fakeMint,
            tokenAmount1,
            solAmount1,
        );
        console.log(`generate uuid1: ${uuid1}`);

        // calculate escrow account address offchain without create it
        let [escrow1] = web3.PublicKey.findProgramAddressSync([Buffer.from(uuid1)], program.programId);
        console.log(`offchain escrow1: ${escrow1}`);

        let memo = Buffer.from([1, 2, 3, 4, 5]);

        // transfer out
        tx = await program.methods
            .prepare(uuid1, lp.publicKey, solAmount1, tokenAmount1, lock, isOut, memo)
            .accounts({
                payer: user.publicKey,
                from: user.publicKey,
                mint: null,
                source: null,
                escrow: escrow1,
                escrowAta: null,
                adminSettings: adminSettings,
                tokenSettings: null,
                associatedTokenProgram: null,
                systemProgram: web3.SystemProgram.programId,
                tokenProgram: null,
            })
            .signers([user])
            .rpc();

        console.log(`transfer out tx: ${tx}`);

        console.log(`========== transfer in ==========`);
        let uuid2 = generateUuid(
            lp.publicKey,
            user.publicKey,
            lock.hash,
            lock.agreementReachedTime,
            lock.expectedSingleStepTime,
            lock.tolerantSingleStepTime,
            lock.earliestRefundTime,
            fakeMint,
            tokenAmount1,
            solAmount1,
        );
        console.log(`generate uuid2: ${uuid2}`);

        // calculate escrow account address offchain without create it
        let [escrow2] = web3.PublicKey.findProgramAddressSync([Buffer.from(uuid2)], program.programId);
        console.log(`offchain escrow2: ${escrow2}`);

        // lp response to the swap initiated by user (transfer in)
        const tx2 = await program.methods
            .prepare(uuid2, user.publicKey, solAmount1, tokenAmount1, lock, isIn, memo)
            .accounts({
                payer: lp.publicKey,
                from: lp.publicKey,
                mint: null,
                source: null,
                escrow: escrow2,
                escrowAta: null,
                adminSettings: adminSettings,
                tokenSettings: null,
                associatedTokenProgram: null,
                systemProgram: web3.SystemProgram.programId,
                tokenProgram: null,
            })
            .signers([lp])
            .rpc();

        console.log(`transfer in tx: ${tx2}`);

        console.log(`========== confirm transfer out ==========`);

        // user confirm the swap (transfer out)
        const tx3 = await program.methods
            .confirm(uuid1, preimage, isOut)
            .accounts({
                payer: user.publicKey,
                from: user.publicKey,
                to: lp.publicKey,
                destination: null,
                escrow: escrow1,
                escrowAta: null,
                adminSettings: adminSettings,
                feeRecepient: feeRecepient.publicKey,
                feeDestination: null,
                systemProgram: web3.SystemProgram.programId,
                tokenProgram: null,
            })
            .signers([user])
            .rpc();

        console.log(`confirm transfer out tx: ${tx3}`);

        console.log(`========== confirm transfer in ==========`);
        // lp confirm the swap (transfer in)
        const tx4 = await program.methods
            .confirm(uuid2, preimage, isIn)
            .accounts({
                payer: lp.publicKey,
                from: lp.publicKey,
                to: user.publicKey,
                destination: null,
                escrow: escrow2,
                escrowAta: null,
                adminSettings: adminSettings,
                feeRecepient: feeRecepient.publicKey,
                feeDestination: null,
                systemProgram: web3.SystemProgram.programId,
                tokenProgram: null,
            })
            .signers([lp])
            .rpc();

        console.log(`confirm transfer in tx: ${tx4}`);

        let userSOLBalAfter = new BN(await connection.getBalance(user.publicKey));
        expect(userSOLBalBefore.sub(userSOLBalAfter).toNumber()).to.be.eq(feeSOL.toNumber());

        let lpSOLBalAfter = new BN(await connection.getBalance(lp.publicKey));
        expect(lpSOLBalBefore.sub(lpSOLBalAfter).toNumber()).to.be.eq(feeSOL.toNumber());

        let feeRecepientSOLBalAfter = new BN(await connection.getBalance(feeRecepient.publicKey));
        expect(feeRecepientSOLBalAfter.sub(feeRecepientSOLBalBefore).toString()).to.be.eq(
            feeSOL.mul(new BN(2)).toString(),
        );
    });

    it("cannot call initiate after deadline", async () => {
        let slot = await connection.getSlot();
        let agreementReachedTime = await connection.getBlockTime(slot);
        if (!agreementReachedTime) {
            throw new Error("agreementReachedTime is null");
        }

        let expectedSingleStepTime = 1;
        let tolerantSingleStepTime = 1;

        let lock = {
            hash: hashlock,
            agreementReachedTime: new BN(agreementReachedTime),
            expectedSingleStepTime: new BN(expectedSingleStepTime),
            tolerantSingleStepTime: new BN(tolerantSingleStepTime),
            earliestRefundTime: new BN(
                agreementReachedTime + 3 * expectedSingleStepTime + 3 * tolerantSingleStepTime + 1,
            ),
        };

        console.log(`lock: ${JSON.stringify(lock)}`);

        let uuid1 = generateUuid(
            user.publicKey,
            lp.publicKey,
            lock.hash,
            lock.agreementReachedTime,
            lock.expectedSingleStepTime,
            lock.tolerantSingleStepTime,
            lock.earliestRefundTime,
            mint1,
            tokenAmount,
            solAmount,
        );
        console.log(`generate uuid1: ${uuid1}`);

        // calculate escrow account address offchain without create it
        let [escrow1] = web3.PublicKey.findProgramAddressSync([Buffer.from(uuid1)], program.programId);
        console.log(`offchain escrow1: ${escrow1}`);

        // calculate escrowAtaTokenAccount account address offchain without create it
        let escrow1AtaTokenAccount = getAssociatedTokenAddressSync(mint1, escrow1, true);
        console.log(`offchain escrow1 ata ${escrow1AtaTokenAccount}`);

        let memo = Buffer.from([1, 2, 3, 4, 5]);

        // sleep until the transfer out deadline
        await sleep(5000);

        try {
            await program.methods
                .prepare(uuid1, lp.publicKey, solAmount, tokenAmount, lock, isOut, memo)
                .accounts({
                    payer: user.publicKey,
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
                .signers([user])
                .rpc();
        } catch (err: any) {
            console.log(`if it exceeds transfer out time limit, it should throw error`);
            console.log(`========== error ==========`);
            console.log((err as AnchorError).logs);
            expect((err as AnchorError).logs).not.to.be.empty;
        }
    });

    it("cannot call initiate with amount 0", async () => {
        let slot = await connection.getSlot();
        let agreementReachedTime = await connection.getBlockTime(slot);
        if (!agreementReachedTime) {
            throw new Error("agreementReachedTime is null");
        }

        let expectedSingleStepTime = 2;
        let tolerantSingleStepTime = 3;

        let lock = {
            hash: hashlock,
            agreementReachedTime: new BN(agreementReachedTime),
            expectedSingleStepTime: new BN(expectedSingleStepTime),
            tolerantSingleStepTime: new BN(tolerantSingleStepTime),
            earliestRefundTime: new BN(
                agreementReachedTime + 3 * expectedSingleStepTime + 3 * tolerantSingleStepTime + 1,
            ),
        };
        console.log(`lock: ${JSON.stringify(lock)}`);

        let uuid1 = generateUuid(
            user.publicKey,
            lp.publicKey,
            lock.hash,
            lock.agreementReachedTime,
            lock.expectedSingleStepTime,
            lock.tolerantSingleStepTime,
            lock.earliestRefundTime,
            mint1,
            tokenAmount,
            solAmount,
        );
        console.log(`generate uuid1: ${uuid1}`);

        // calculate escrow account address offchain without create it
        let [escrow1] = web3.PublicKey.findProgramAddressSync([Buffer.from(uuid1)], program.programId);
        console.log(`offchain escrow1: ${escrow1}`);

        // calculate escrowAtaTokenAccount account address offchain without create it
        let escrow1AtaTokenAccount = getAssociatedTokenAddressSync(mint1, escrow1, true);
        console.log(`offchain escrow1 ata ${escrow1AtaTokenAccount}`);

        let memo = Buffer.from([1, 2, 3, 4, 5]);

        try {
            await program.methods
                .prepare(uuid1, lp.publicKey, solAmount, new BN(0), lock, isOut, memo)
                .accounts({
                    payer: user.publicKey,
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
                .signers([user, user])
                .rpc();
        } catch (err: any) {
            console.log(`if the token amount is 0, it should throw error`);
            console.log(`========== error ==========`);
            console.log((err as AnchorError).logs);
            expect((err as AnchorError).logs).not.to.be.empty;
        }
    });

    it("refund SPL A Token <-> SPL B Token + SOL", async () => {
        let slot = await connection.getSlot();
        let agreementReachedTime = await connection.getBlockTime(slot);
        if (!agreementReachedTime) {
            throw new Error("agreementReachedTime is null");
        }

        let expectedSingleStepTime = 1;
        let tolerantSingleStepTime = 1;
        let earliestRefundTime = agreementReachedTime + 3 * expectedSingleStepTime + 3 * tolerantSingleStepTime + 1;

        let lock = {
            hash: hashlock,
            agreementReachedTime: new BN(agreementReachedTime),
            expectedSingleStepTime: new BN(expectedSingleStepTime),
            tolerantSingleStepTime: new BN(tolerantSingleStepTime),
            earliestRefundTime: new BN(earliestRefundTime),
        };
        console.log(`lock: ${JSON.stringify(lock)}`);

        let uuid1 = generateUuid(
            user.publicKey,
            lp.publicKey,
            lock.hash,
            lock.agreementReachedTime,
            lock.expectedSingleStepTime,
            lock.tolerantSingleStepTime,
            lock.earliestRefundTime,
            mint1,
            tokenAmount,
            solAmount,
        );
        console.log(`generate uuid1: ${uuid1}`);

        // calculate escrow account address offchain without create it
        let [escrow1] = web3.PublicKey.findProgramAddressSync([Buffer.from(uuid1)], program.programId);
        console.log(`offchain escrow1: ${escrow1}`);

        // calculate escrowAtaTokenAccount account address offchain without create it
        let escrow1AtaTokenAccount = getAssociatedTokenAddressSync(mint1, escrow1, true);
        console.log(`offchain escrow1 ata ${escrow1AtaTokenAccount}`);

        let memo = Buffer.from([1, 2, 3, 4, 5]);

        let userMint1BalBefore = new BN(userAtaTokenMint1Account.amount.toString());
        let userMint2BalBefore = new BN(0);
        let userSOLBalBefore = new BN(await connection.getBalance(user.publicKey));

        let lpMint1BalBefore = new BN(0);
        let lpMint2BalBefore = new BN(lpAtaTokenMint2Account.amount.toString());
        let lpSOLBalBefore = new BN(await connection.getBalance(lp.publicKey));

        // user initate a swap by sending transfer out
        console.log(`========== transfer out ==========`);
        tx = await program.methods
            .prepare(uuid1, lp.publicKey, solAmount, tokenAmount, lock, isOut, memo)
            .accounts({
                payer: user.publicKey,
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
            .signers([user, user])
            .rpc();

        console.log(`transfer out tx: ${tx}`);

        console.log(`========== transfer in ==========`);
        let uuid2 = generateUuid(
            lp.publicKey,
            user.publicKey,
            lock.hash,
            lock.agreementReachedTime,
            lock.expectedSingleStepTime,
            lock.tolerantSingleStepTime,
            lock.earliestRefundTime,
            mint2,
            tokenAmountBack,
            solAmountBack,
        );
        console.log(`generate uuid2: ${uuid2}`);

        // calculate escrow account address offchain without create it
        let [escrow2] = web3.PublicKey.findProgramAddressSync([Buffer.from(uuid2)], program.programId);
        console.log(`offchain escrow2: ${escrow2}`);

        // calculate escrowAtaTokenAccount account address offchain without create it
        let escrow2AtaTokenAccount = getAssociatedTokenAddressSync(mint2, escrow2, true);
        console.log(`offchain escrow2 ata ${escrow2AtaTokenAccount}`);

        // lp response to the swap initiated by user (transfer in)
        const tx2 = await program.methods
            .prepare(uuid2, user.publicKey, solAmountBack, tokenAmountBack, lock, isIn, memo)
            .accounts({
                payer: lp.publicKey,
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
            .signers([lp])
            .rpc();

        console.log(`transfer in tx: ${tx2}`);

        console.log(`========== refund transfer out ==========`);
        try {
            // if user refund the swap before the agreement reached time + 6 * stepTimelock, it should throw error
            await program.methods
                .refund(uuid1, isOut)
                .accounts({
                    from: user.publicKey,
                    source: userAtaTokenMint1Account.address,
                    escrow: escrow1,
                    escrowAta: escrow1AtaTokenAccount,
                    systemProgram: web3.SystemProgram.programId,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .rpc();
        } catch (err: any) {
            console.log(`if it does not reach refund window, it should throw error`);
            console.log(`========== error ==========`);
            console.log((err as AnchorError).logs);
            expect((err as AnchorError).logs).not.to.be.empty;
        }
        console.log(`wait until the earliestRefundTime: ${lock.earliestRefundTime}`);
        while (true) {
            let slot = await connection.getSlot();
            let currentTime = await connection.getBlockTime(slot);
            if (!currentTime) {
                throw new Error("currentTime is null");
            }
            console.log(`currentTime: ${currentTime}`);
            if (currentTime >= earliestRefundTime) {
                break;
            }
            await sleep(1000);
        }

        // user refund the swap (transfer out)
        const tx5 = await program.methods
            .refund(uuid1, isOut)
            .accounts({
                from: user.publicKey,
                source: userAtaTokenMint1Account.address,
                escrow: escrow1,
                escrowAta: escrow1AtaTokenAccount,
                systemProgram: web3.SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .rpc();

        console.log(`user refund transfer out tx: ${tx5}`);

        console.log(`========== refund transfer in ==========`);
        // lp refund the swap (transfer in)
        const tx6 = await program.methods
            .refund(uuid2, isIn)
            .accounts({
                from: lp.publicKey,
                source: lpAtaTokenMint2Account.address,
                escrow: escrow2,
                escrowAta: escrow2AtaTokenAccount,
                systemProgram: web3.SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .rpc();

        console.log(`lp refund transfer in tx: ${tx6}`);

        let userMint1BalAfter = new BN(
            (await getAccount(connection, userAtaTokenMint1Account.address)).amount.toString(),
        );
        let userSOLBalAfter = new BN(await connection.getBalance(user.publicKey));
        expect(userMint1BalBefore.toString()).to.be.eq(userMint1BalAfter.toString());
        expect(userSOLBalAfter.toNumber()).to.be.eq(userSOLBalBefore.toNumber());

        let lpMint2BalAfter = new BN((await getAccount(connection, lpAtaTokenMint2Account.address)).amount.toString());
        let lpSOLBalAfter = new BN(await connection.getBalance(lp.publicKey));
        expect(lpMint2BalAfter.toString()).to.be.eq(lpMint2BalBefore.toString());
        expect(lpSOLBalBefore.toNumber()).to.be.eq(lpSOLBalAfter.toNumber());
    });

    it("refund SOL <-> SOL", async () => {
        let slot = await connection.getSlot();
        let agreementReachedTime = await connection.getBlockTime(slot);
        if (!agreementReachedTime) {
            throw new Error("agreementReachedTime is null");
        }

        let expectedSingleStepTime = 1;
        let tolerantSingleStepTime = 1;
        let earliestRefundTime = agreementReachedTime + 3 * expectedSingleStepTime + 3 * tolerantSingleStepTime + 1;

        let lock = {
            hash: hashlock,
            agreementReachedTime: new BN(agreementReachedTime),
            expectedSingleStepTime: new BN(expectedSingleStepTime),
            tolerantSingleStepTime: new BN(tolerantSingleStepTime),
            earliestRefundTime: new BN(earliestRefundTime),
        };
        console.log(`lock: ${JSON.stringify(lock)}`);

        const ZERO_PUBKEY = new web3.PublicKey(new Uint8Array(32).fill(0));
        const fakeMint = ZERO_PUBKEY;
        const solAmount1 = new BN(2 * 10 ** 9);
        const tokenAmount1 = new BN(0);

        let uuid1 = generateUuid(
            user.publicKey,
            lp.publicKey,
            lock.hash,
            lock.agreementReachedTime,
            lock.expectedSingleStepTime,
            lock.tolerantSingleStepTime,
            lock.earliestRefundTime,
            fakeMint,
            tokenAmount1,
            solAmount1,
        );
        console.log(`generate uuid1: ${uuid1}`);

        // calculate escrow account address offchain without create it
        let [escrow1] = web3.PublicKey.findProgramAddressSync([Buffer.from(uuid1)], program.programId);
        console.log(`offchain escrow1: ${escrow1}`);

        let memo = Buffer.from([1, 2, 3, 4, 5]);

        let userSOLBalBefore = new BN(await connection.getBalance(user.publicKey));
        let lpSOLBalBefore = new BN(await connection.getBalance(lp.publicKey));

        // user initate a swap by sending transfer out
        console.log(`========== transfer out ==========`);
        tx = await program.methods
            .prepare(uuid1, lp.publicKey, solAmount1, tokenAmount1, lock, isOut, memo)
            .accounts({
                payer: user.publicKey,
                from: user.publicKey,
                mint: null,
                source: null,
                escrow: escrow1,
                escrowAta: null,
                adminSettings: adminSettings,
                tokenSettings: null,
                associatedTokenProgram: null,
                systemProgram: web3.SystemProgram.programId,
                tokenProgram: null,
            })
            .signers([user, user])
            .rpc();

        console.log(`transfer out tx: ${tx}`);

        console.log(`========== transfer in ==========`);
        let uuid2 = generateUuid(
            lp.publicKey,
            user.publicKey,
            lock.hash,
            lock.agreementReachedTime,
            lock.expectedSingleStepTime,
            lock.tolerantSingleStepTime,
            lock.earliestRefundTime,
            fakeMint,
            tokenAmount1,
            solAmount1,
        );
        console.log(`generate uuid2: ${uuid2}`);

        // calculate escrow account address offchain without create it
        let [escrow2] = web3.PublicKey.findProgramAddressSync([Buffer.from(uuid2)], program.programId);
        console.log(`offchain escrow2: ${escrow2}`);

        // lp response to the swap initiated by user (transfer in)
        const tx2 = await program.methods
            .prepare(uuid2, user.publicKey, solAmount1, tokenAmount1, lock, isIn, memo)
            .accounts({
                payer: lp.publicKey,
                from: lp.publicKey,
                mint: null,
                source: null,
                escrow: escrow2,
                escrowAta: null,
                adminSettings: adminSettings,
                tokenSettings: null,
                associatedTokenProgram: null,
                systemProgram: web3.SystemProgram.programId,
                tokenProgram: null,
            })
            .signers([lp])
            .rpc();

        console.log(`transfer in tx: ${tx2}`);

        console.log(`========== refund transfer out ==========`);
        try {
            // if user refund the swap before the agreement reached time + 6 * stepTimelock, it should throw error
            await program.methods
                .refund(uuid1, isOut)
                .accounts({
                    from: user.publicKey,
                    source: null,
                    escrow: escrow1,
                    escrowAta: null,
                    systemProgram: web3.SystemProgram.programId,
                    tokenProgram: null,
                })
                .rpc();
        } catch (err: any) {
            console.log(`if it does not reach refund window, it should throw error`);
            console.log(`========== error ==========`);
            console.log((err as AnchorError).logs);
            expect((err as AnchorError).logs).not.to.be.empty;
        }
        console.log(`wait until the earliestRefundTime: ${lock.earliestRefundTime}`);
        while (true) {
            let slot = await connection.getSlot();
            let currentTime = await connection.getBlockTime(slot);
            if (!currentTime) {
                throw new Error("currentTime is null");
            }
            console.log(`currentTime: ${currentTime}`);
            if (currentTime >= earliestRefundTime) {
                break;
            }
            await sleep(1000);
        }

        // user refund the swap (transfer out)
        const tx5 = await program.methods
            .refund(uuid1, isOut)
            .accounts({
                from: user.publicKey,
                source: null,
                escrow: escrow1,
                escrowAta: null,
                systemProgram: web3.SystemProgram.programId,
                tokenProgram: null,
            })
            .rpc();

        console.log(`user refund transfer out tx: ${tx5}`);

        console.log(`========== refund transfer in ==========`);
        // lp refund the swap (transfer in)
        const tx6 = await program.methods
            .refund(uuid2, isIn)
            .accounts({
                from: lp.publicKey,
                source: null,
                escrow: escrow2,
                escrowAta: null,
                systemProgram: web3.SystemProgram.programId,
                tokenProgram: null,
            })
            .rpc();

        console.log(`lp refund transfer in tx: ${tx6}`);

        let userSOLBalAfter = new BN(await connection.getBalance(user.publicKey));
        expect(userSOLBalBefore.toNumber()).to.be.eq(userSOLBalAfter.toNumber());

        let lpSOLBalAfter = new BN(await connection.getBalance(lp.publicKey));
        expect(lpSOLBalBefore.toNumber()).to.be.eq(lpSOLBalAfter.toNumber());
    });

    it("nonexisting account test", async () => {
        // create lp offchain and see what happens
        lp = web3.Keypair.generate();
        const lpBal = await connection.getBalance(lp.publicKey);
        console.log(`lp: ${lp.publicKey} balance: ${lpBal / web3.LAMPORTS_PER_SOL} SOL`);
        tokenAmountBack = new BN(5 * 10 ** 9);

        let slot = await connection.getSlot();
        let agreementReachedTime = await connection.getBlockTime(slot);
        if (!agreementReachedTime) {
            throw new Error("agreementReachedTime is null");
        }

        let expectedSingleStepTime = 2;
        let tolerantSingleStepTime = 3;

        let lock = {
            hash: hashlock,
            agreementReachedTime: new BN(agreementReachedTime),
            expectedSingleStepTime: new BN(expectedSingleStepTime),
            tolerantSingleStepTime: new BN(tolerantSingleStepTime),
            earliestRefundTime: new BN(
                agreementReachedTime + 3 * expectedSingleStepTime + 3 * tolerantSingleStepTime + 1,
            ),
        };
        console.log(`lock: ${JSON.stringify(lock)}`);

        console.log(`========== before swap ==========`);
        await splTokensBalance(connection, user.publicKey);
        await splTokensBalance(connection, lp.publicKey);

        console.log(`========== transfer out ==========`);
        let uuid1 = generateUuid(
            user.publicKey,
            lp.publicKey,
            lock.hash,
            lock.agreementReachedTime,
            lock.expectedSingleStepTime,
            lock.tolerantSingleStepTime,
            lock.earliestRefundTime,
            mint1,
            tokenAmount,
            new BN(0),
        );
        console.log(`generate uuid1: ${uuid1}`);

        // calculate escrow account address offchain without create it
        let [escrow1] = web3.PublicKey.findProgramAddressSync([Buffer.from(uuid1)], program.programId);
        console.log(`offchain escrow1: ${escrow1}`);

        // calculate escrowAtaTokenAccount account address offchain without create it
        let escrow1AtaTokenAccount = getAssociatedTokenAddressSync(mint1, escrow1, true);
        console.log(`offchain escrow1 ata ${escrow1AtaTokenAccount}`);

        let memo = Buffer.from([1, 2, 3, 4, 5]);

        // set fee rate to 0%
        tx = await program.methods
            .setFeeRate(0)
            .accounts({
                admin: newAdmin.publicKey,
                adminSettings: adminSettings,
            })
            .signers([newAdmin])
            .rpc();

        console.log(`set fee rate tx: ${tx}`);

        // user initiate the swap (transfer out)
        tx = await program.methods
            .prepare(uuid1, lp.publicKey, new BN(0), tokenAmount, lock, isOut, memo)
            .accounts({
                payer: user.publicKey,
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
            .signers([user])
            .rpc();

        console.log(`transfer out tx: ${tx}`);

        console.log(`========== confirm transfer out ==========`);
        // lp token mint1 ata address
        let lpAtaTokenMint1Account = await getOrCreateAssociatedTokenAccount(connection, payer, mint1, lp.publicKey);

        // fee recepient mint1 ata address
        let feeMin1Destination = await getOrCreateAssociatedTokenAccount(
            connection,
            payer,
            mint1,
            feeRecepient.publicKey,
        );

        // user confirm the swap (transfer out)
        const tx3 = await program.methods
            .confirm(uuid1, preimage, isOut)
            .accounts({
                payer: user.publicKey,
                from: user.publicKey,
                to: lp.publicKey,
                destination: lpAtaTokenMint1Account.address,
                escrow: escrow1,
                escrowAta: escrow1AtaTokenAccount,
                adminSettings: adminSettings,
                feeRecepient: feeRecepient.publicKey,
                feeDestination: feeMin1Destination.address,
                systemProgram: web3.SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([user])
            .rpc();

        console.log(`confirm transfer out tx: ${tx3}`);

        console.log(`========== after swap ==========`);
        await splTokensBalance(connection, user.publicKey);
        await splTokensBalance(connection, lp.publicKey);
    });

    it("cannot confirm out by using confirm in function", async () => {
        let slot = await connection.getSlot();
        let agreementReachedTime = await connection.getBlockTime(slot);
        if (!agreementReachedTime) {
            throw new Error("agreementReachedTime is null");
        }

        let expectedSingleStepTime = 5;
        let tolerantSingleStepTime = 10;

        let lock = {
            hash: hashlock,
            agreementReachedTime: new BN(agreementReachedTime),
            expectedSingleStepTime: new BN(expectedSingleStepTime),
            tolerantSingleStepTime: new BN(tolerantSingleStepTime),
            earliestRefundTime: new BN(
                agreementReachedTime + 3 * expectedSingleStepTime + 3 * tolerantSingleStepTime + 1,
            ),
        };
        console.log(`lock: ${JSON.stringify(lock)}`);

        console.log(`========== transfer out ==========`);
        let uuid1 = generateUuid(
            user.publicKey,
            lp.publicKey,
            lock.hash,
            lock.agreementReachedTime,
            lock.expectedSingleStepTime,
            lock.tolerantSingleStepTime,
            lock.earliestRefundTime,
            mint1,
            tokenAmount,
            solAmount,
        );
        console.log(`generate uuid1: ${uuid1}`);

        // calculate escrow account address offchain without create it
        let [escrow1] = web3.PublicKey.findProgramAddressSync([Buffer.from(uuid1)], program.programId);
        console.log(`offchain escrow1: ${escrow1}`);

        // calculate escrowAtaTokenAccount account address offchain without create it
        let escrow1AtaTokenAccount = getAssociatedTokenAddressSync(mint1, escrow1, true);
        console.log(`offchain escrow1 ata ${escrow1AtaTokenAccount}`);

        let memo = Buffer.from([1, 2, 3, 4, 5]);

        // transfer out
        tx = await program.methods
            .prepare(uuid1, lp.publicKey, solAmount, tokenAmount, lock, isOut, memo)
            .accounts({
                payer: user.publicKey,
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
            .signers([user])
            .rpc();

        console.log(`transfer out tx: ${tx}`);

        console.log(`========== transfer in ==========`);
        let uuid2 = generateUuid(
            lp.publicKey,
            user.publicKey,
            lock.hash,
            lock.agreementReachedTime,
            lock.expectedSingleStepTime,
            lock.tolerantSingleStepTime,
            lock.earliestRefundTime,
            mint2,
            tokenAmountBack,
            solAmountBack,
        );
        console.log(`generate uuid2: ${uuid2}`);

        // calculate escrow account address offchain without create it
        let [escrow2] = web3.PublicKey.findProgramAddressSync([Buffer.from(uuid2)], program.programId);
        console.log(`offchain escrow2: ${escrow2}`);

        // calculate escrowAtaTokenAccount account address offchain without create it
        let escrow2AtaTokenAccount = getAssociatedTokenAddressSync(mint2, escrow2, true);
        console.log(`offchain escrow2 ata ${escrow2AtaTokenAccount}`);

        // lp response to the swap initiated by user (transfer in)
        const tx2 = await program.methods
            .prepare(uuid2, user.publicKey, solAmountBack, tokenAmountBack, lock, isIn, memo)
            .accounts({
                payer: lp.publicKey,
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
            .signers([lp])
            .rpc();

        console.log(`transfer in tx: ${tx2}`);

        console.log(`========== try to confirm transfer out by using confirm in function ==========`);

        // lp token mint1 ata address
        let lpAtaTokenMint1Account = await getOrCreateAssociatedTokenAccount(connection, payer, mint1, lp.publicKey);

        // fee recepient mint1 ata address
        let feeMin1Destination = await getOrCreateAssociatedTokenAccount(
            connection,
            payer,
            mint1,
            feeRecepient.publicKey,
        );
        // user cannot confirm the swap by using confirm in function
        try {
            const tx3 = await program.methods
                .confirm(uuid1, preimage, isIn)
                .accounts({
                    payer: user.publicKey,
                    from: user.publicKey,
                    to: lp.publicKey,
                    destination: lpAtaTokenMint1Account.address,
                    escrow: escrow1,
                    escrowAta: escrow1AtaTokenAccount,
                    adminSettings: adminSettings,
                    feeRecepient: feeRecepient.publicKey,
                    feeDestination: feeMin1Destination.address,
                    systemProgram: web3.SystemProgram.programId,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([user])
                .rpc();
        } catch (err) {
            console.log(`if it is not transfer out, it should throw error`);
            console.log(`========== error ==========`);
            console.log((err as AnchorError).logs);
            expect((err as AnchorError).logs).not.to.be.empty;
        }
    });
});
