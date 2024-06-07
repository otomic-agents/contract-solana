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
import { createAccountOnChain, airdropSOL, createSPLTokenAndMintToUser, sleep, splTokensBalance } from './helper';
import { expect } from 'chai';

type Lock = {
    hash: Array<number>;
    deadline: BN;
};

describe('nonexisting account', () => {
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

    let user: web3.Keypair;
    let amount: number;
    let mint1: web3.PublicKey;
    let userAtaTokenMint1Account: Account;

    let lp: web3.Keypair;
    let amountBack: number;
    let mint2: web3.PublicKey;
    let lpAtaTokenMint2Account: Account;

    let preimage: Array<number>;
    let relayPreimage: Array<number>;
    let agreementReachedTime: number;
    let stepTimelock: number;
    let hashlock: Array<number>;
    let relayHashlock: Array<number>;

    it('nonexisting account test', async () => {
        console.log(`========== setup up ==========`);
        await airdropSOL(connection, payer, 10 * 10 ** 9);
        const payerBal = await connection.getBalance(payer.publicKey);
        console.log(`payer ${payer.publicKey} balance: ${payerBal / web3.LAMPORTS_PER_SOL} SOL`);

        user = await createAccountOnChain(connection, payer);
        console.log(`user: ${user.publicKey}`);

        amount = 2 * 10 ** 9;
        let ret = await createSPLTokenAndMintToUser(connection, payer, user, amount);
        mint1 = ret.mint;
        userAtaTokenMint1Account = ret.ataTokenAccount;
        console.log(
            `create SPL token mint1 ${mint1} and user ${user.publicKey} ata account ${userAtaTokenMint1Account.address}`,
        );
        userAtaTokenMint1Account = await getAccount(connection, userAtaTokenMint1Account.address);
        console.log(
            `user ata token mint1 account ${userAtaTokenMint1Account.address} balance: ${userAtaTokenMint1Account.amount}`,
        );

        // create lp offchain and see what happens
        lp = web3.Keypair.generate();
        console.log(`lp: ${lp.publicKey}`);
        amountBack = 5 * 10 ** 9;
        ret = await createSPLTokenAndMintToUser(connection, payer, lp, amountBack);
        mint2 = ret.mint;
        lpAtaTokenMint2Account = ret.ataTokenAccount;
        console.log(
            `create SPL token mint2 ${mint2} and lp ${lp.publicKey} ata account ${lpAtaTokenMint2Account.address}`,
        );
        lpAtaTokenMint2Account = await getAccount(connection, lpAtaTokenMint2Account.address);
        console.log(
            `lp ata token mint2 account ${lpAtaTokenMint2Account.address} balance: ${lpAtaTokenMint2Account.amount}`,
        );

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
        stepTimelock = 60;
        console.log(`stepTimelock: ${stepTimelock}`);

        hashlock = Array.from(keccak_256(Buffer.from(preimage)));
        relayHashlock = Array.from(keccak_256(Buffer.from(relayPreimage)));

        console.log(`========== before swap ==========`);
        await splTokensBalance(connection, user.publicKey);
        await splTokensBalance(connection, lp.publicKey);

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

        let transferOutDeadline = agreementReachedTime + 1 * stepTimelock;
        let refundDeadline = agreementReachedTime + 7 * stepTimelock;

        // user initiate the swap (transfer out)
        const tx = await program.methods
            .initiate(
                uuid1,
                lp.publicKey,
                new BN(amount),
                lockUser,
                lockRelay,
                new BN(transferOutDeadline),
                new BN(refundDeadline),
                extraData,
            )
            .accounts({
                payer: payer.publicKey,
                from: user.publicKey,
                mint: mint1,
                source: userAtaTokenMint1Account.address,
                escrow: escrow1,
                escrowAta: escrow1AtaTokenAccount,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: web3.SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([payer, user])
            .rpc();

        console.log(`transfer out tx: ${tx}`);

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
            .initiate(
                uuid2,
                user.publicKey,
                new BN(amountBack),
                lockLp,
                null,
                new BN(transferInDeadline),
                new BN(refundDeadline),
                extraData,
            )
            .accounts({
                payer: payer.publicKey,
                from: lp.publicKey,
                mint: mint2,
                source: lpAtaTokenMint2Account.address,
                escrow: escrow2,
                escrowAta: escrow2AtaTokenAccount,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: web3.SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([payer, lp])
            .rpc();

        console.log(`transfer in tx: ${tx2}`);

        console.log(`========== confirm transfer out ==========`);
        // lp token mint1 ata address
        let lpAtaTokenMint1Account = await getOrCreateAssociatedTokenAccount(connection, payer, mint1, lp.publicKey);
        // user confirm the swap (transfer out)
        const tx3 = await program.methods
            .confirm(uuid1, preimage)
            .accounts({
                destination: lpAtaTokenMint1Account.address,
                escrow: escrow1,
                escrowAta: escrow1AtaTokenAccount,
                systemProgram: web3.SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
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
        // lp confirm the swap (transfer in)
        const tx4 = await program.methods
            .confirm(uuid2, preimage)
            .accounts({
                destination: userAtaTokenMint2Account.address,
                escrow: escrow2,
                escrowAta: escrow2AtaTokenAccount,
                systemProgram: web3.SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .rpc();

        console.log(`confirm transfer in tx: ${tx4}`);

        console.log(`========== after swap ==========`);
        await splTokensBalance(connection, user.publicKey);
        await splTokensBalance(connection, lp.publicKey);
    });
});
