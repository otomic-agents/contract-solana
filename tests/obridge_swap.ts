import crypto from "crypto";
import * as anchor from "@coral-xyz/anchor";
import { Program, web3, AnchorError } from "@coral-xyz/anchor";
import { ObridgeSwap } from "../target/types/obridge_swap";
import {
    getAccount,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    getAssociatedTokenAddressSync,
    getOrCreateAssociatedTokenAccount,
    Account,
} from "@solana/spl-token";
import BN, { min } from "bn.js";
import {
    createAccountOnChain,
    airdropSOL,
    createSPLTokenAndMintToUser,
    transferSOL,
    sleep,
    splTokensBalance,
    generateUuidSwap,
} from "./helper";
import { expect } from "chai";

type Lock = {
    agreementReachedTime: BN;
    stepTime: BN;
};

describe("OBridge Swap", () => {
    // Configure the client to use the local cluster.
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const connection = provider.connection;
    console.log(`network connected: ${connection.rpcEndpoint}`);
    const program = anchor.workspace.ObridgeSwap as Program<ObridgeSwap>;
    console.log(`obridge_swap program: ${program.programId}`);

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
    let amount: BN;
    let mint1: web3.PublicKey;
    let mint1Settings: web3.PublicKey;
    let userAtaTokenMint1Account: Account;

    let lp: web3.Keypair;
    let amountBack: BN;
    let mint2: web3.PublicKey;
    let mint2Settings: web3.PublicKey;
    let lpAtaTokenMint2Account: Account;

    let adminSettings: web3.PublicKey;

    let userAtaTokenMint2Account: Account;
    let lpAtaTokenMint1Account: Account;
    let feeMint1Destination: Account;
    let feeMint2Destination: Account;

    let tx: string;

    beforeEach(async () => {
        console.log(`========== setup up ==========`);
        await airdropSOL(connection, payer, 1000 * 10 ** 9);
        const payerBal = await connection.getBalance(payer.publicKey);
        console.log(`payer ${payer.publicKey} balance: ${payerBal / web3.LAMPORTS_PER_SOL} SOL`);

        amount = new BN(2 * 10 ** 9);
        user = await createAccountOnChain(connection, payer);
        await transferSOL(connection, payer, user.publicKey, 20 * 10 ** 9);
        const userBal = await connection.getBalance(user.publicKey);
        console.log(`user: ${user.publicKey} balance: ${userBal / web3.LAMPORTS_PER_SOL} SOL`);

        let ret = await createSPLTokenAndMintToUser(connection, payer, user, amount.toNumber());
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

        amountBack = new BN(5 * 10 ** 9);
        lp = await createAccountOnChain(connection, payer);
        await transferSOL(connection, payer, lp.publicKey, 20 * 10 ** 9);
        const lpBal = await connection.getBalance(lp.publicKey);
        console.log(`lp: ${lp.publicKey} balance: ${lpBal / web3.LAMPORTS_PER_SOL} SOL`);

        ret = await createSPLTokenAndMintToUser(connection, payer, lp, amountBack.toNumber());
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

        // user token mint2 ata address
        userAtaTokenMint2Account = await getOrCreateAssociatedTokenAccount(connection, payer, mint2, user.publicKey);
        console.log(`user mint2 ata ${userAtaTokenMint2Account.address}`);

        // lp token mint1 ata address
        lpAtaTokenMint1Account = await getOrCreateAssociatedTokenAccount(connection, payer, mint1, lp.publicKey);
        console.log(`lp mint1 ata ${lpAtaTokenMint1Account.address}`);

        // fee recepient mint2 ata address
        feeMint1Destination = await getOrCreateAssociatedTokenAccount(connection, payer, mint1, feeRecepient.publicKey);
        console.log(`fee mint1 ata ${feeMint1Destination.address}`);

        // fee recepient mint2 ata address
        feeMint2Destination = await getOrCreateAssociatedTokenAccount(connection, payer, mint2, feeRecepient.publicKey);
        console.log(`fee mint2 ata ${feeMint2Destination.address}`);
    });

    it("swap SPL A Token <-> SPL B Token", async () => {
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

        console.log(`========== prepare ==========`);

        let stepTime = 5;

        let lock: Lock = {
            agreementReachedTime: new BN(agreementReachedTime),
            stepTime: new BN(stepTime),
        };
        console.log(`lock: ${JSON.stringify(lock)}`);

        let uuid1 = generateUuidSwap(
            user.publicKey,
            lp.publicKey,
            mint1,
            amount,
            mint2,
            amountBack,
            lock.agreementReachedTime,
            lock.stepTime,
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
                .prepare(uuid1, amount, amountBack, lock, memo)
                .accounts({
                    payer: user.publicKey,
                    from: user.publicKey,
                    to: lp.publicKey,
                    srcToken: mint1,
                    source: userAtaTokenMint1Account.address,
                    dstToken: mint2,
                    escrow: escrow1,
                    escrowAta: escrow1AtaTokenAccount,
                    adminSettings: adminSettings,
                    srcTokenSettings: null,
                    dstTokenSettings: null,
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

        let feeMint1 = amount.mul(new BN(1000)).div(new BN(10000));
        let feeMint2 = amountBack.mul(new BN(1000)).div(new BN(10000));

        // transfer out
        tx = await program.methods
            .prepare(uuid1, amount, amountBack, lock, memo)
            .accounts({
                payer: user.publicKey,
                from: user.publicKey,
                to: lp.publicKey,
                srcToken: mint1,
                source: userAtaTokenMint1Account.address,
                dstToken: mint2,
                escrow: escrow1,
                escrowAta: escrow1AtaTokenAccount,
                adminSettings: adminSettings,
                srcTokenSettings: null,
                dstTokenSettings: null,
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
                .prepare(uuid1, amount, amountBack, lock, memo)
                .accounts({
                    payer: user.publicKey,
                    from: user.publicKey,
                    to: lp.publicKey,
                    srcToken: mint1,
                    source: userAtaTokenMint1Account.address,
                    dstToken: mint2,
                    escrow: escrow1,
                    escrowAta: escrow1AtaTokenAccount,
                    adminSettings: adminSettings,
                    srcTokenSettings: null,
                    dstTokenSettings: null,
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

        console.log(`========== confirm ==========`);

        // lp confirm the swap initiated by user (prepare)
        const tx2 = await program.methods
            .confirm(uuid1)
            .accounts({
                payer: lp.publicKey,
                from: user.publicKey,
                fromDestination: userAtaTokenMint2Account.address,
                to: lp.publicKey,
                toSource: lpAtaTokenMint2Account.address,
                toDestination: lpAtaTokenMint1Account.address,
                escrow: escrow1,
                escrowAta: escrow1AtaTokenAccount,
                adminSettings: adminSettings,
                feeRecepient: feeRecepient.publicKey,
                srcFeeDestination: feeMint1Destination.address,
                dstFeeDestination: feeMint2Destination.address,
                systemProgram: web3.SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([lp])
            .rpc();

        console.log(`confirm tx: ${tx2}`);

        let userMint1BalAfter = new BN(
            (await getAccount(connection, userAtaTokenMint1Account.address)).amount.toString(),
        );
        let userMint2BalAfter = new BN(
            (await getAccount(connection, userAtaTokenMint2Account.address)).amount.toString(),
        );
        let userSOLBalAfter = new BN(await connection.getBalance(user.publicKey));
        expect(userMint1BalBefore.sub(userMint1BalAfter).toString()).to.be.eq(amount.toString());
        expect(userMint2BalAfter.sub(userMint2BalBefore).toString()).to.be.eq(amountBack.sub(feeMint2).toString());
        expect(userSOLBalAfter.toString()).to.be.eq(userSOLBalBefore.toString());

        let lpMint1BalAfter = new BN((await getAccount(connection, lpAtaTokenMint1Account.address)).amount.toString());
        let lpMint2BalAfter = new BN((await getAccount(connection, lpAtaTokenMint2Account.address)).amount.toString());
        let lpSOLBalAfter = new BN(await connection.getBalance(lp.publicKey));
        expect(lpMint1BalAfter.sub(lpMint1BalBefore).toString()).to.be.eq(amount.sub(feeMint1).toString());
        expect(lpMint2BalBefore.sub(lpMint2BalAfter).toString()).to.be.eq(amountBack.toString());
        expect(lpSOLBalAfter.toString()).to.be.eq(lpSOLBalBefore.toString());

        let feeRecepientMint1BalAfter = new BN(
            (await getAccount(connection, feeMint1Destination.address)).amount.toString(),
        );
        let feeRecepientMint2BalAfter = new BN(
            (await getAccount(connection, feeMint2Destination.address)).amount.toString(),
        );
        let feeRecepientSOLBalAfter = new BN(await connection.getBalance(feeRecepient.publicKey));
        expect(feeRecepientMint1BalAfter.sub(feeRecepientMint1BalBefore).toString()).to.be.eq(feeMint1.toString());
        expect(feeRecepientMint2BalAfter.sub(feeRecepientMint2BalBefore).toString()).to.be.eq(feeMint2.toString());
        expect(feeRecepientSOLBalAfter.toString()).to.be.eq(feeRecepientSOLBalBefore.toString());
    });

    it("swap SOL <-> SPL B Token", async () => {
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

        let stepTime = 5;

        let lock: Lock = {
            agreementReachedTime: new BN(agreementReachedTime),
            stepTime: new BN(stepTime),
        };
        console.log(`lock: ${JSON.stringify(lock)}`);

        // zero public key to indicate native token SOL
        const zeroPublicKey = new web3.PublicKey(new Uint8Array(32).fill(0));
        console.log(`zero public key: ${zeroPublicKey.toBase58()}`);

        console.log(`========== prepare ==========`);
        let uuid1 = generateUuidSwap(
            user.publicKey,
            lp.publicKey,
            zeroPublicKey,
            amount,
            mint2,
            amountBack,
            lock.agreementReachedTime,
            lock.stepTime,
        );
        console.log(`generate uuid1: ${uuid1}`);

        // calculate escrow account address offchain without create it
        let [escrow1] = web3.PublicKey.findProgramAddressSync([Buffer.from(uuid1)], program.programId);
        console.log(`offchain escrow1: ${escrow1}`);

        let memo = Buffer.from([1, 2, 3, 4, 5]);

        tx = await program.methods
            .prepare(uuid1, amount, amountBack, lock, memo)
            .accounts({
                payer: user.publicKey,
                from: user.publicKey,
                to: lp.publicKey,
                srcToken: null,
                source: null,
                dstToken: mint2,
                escrow: escrow1,
                escrowAta: null,
                adminSettings: adminSettings,
                srcTokenSettings: null,
                dstTokenSettings: null,
                associatedTokenProgram: null,
                systemProgram: web3.SystemProgram.programId,
                tokenProgram: null,
            })
            .signers([user])
            .rpc();

        console.log(`transfer out tx: ${tx}`);

        console.log(`========== confirm ==========`);

        // lp confirm the swap initiated by user (prepare)
        const tx2 = await program.methods
            .confirm(uuid1)
            .accounts({
                payer: lp.publicKey,
                from: user.publicKey,
                fromDestination: userAtaTokenMint2Account.address,
                to: lp.publicKey,
                toSource: lpAtaTokenMint2Account.address,
                toDestination: null,
                escrow: escrow1,
                escrowAta: null,
                adminSettings: adminSettings,
                feeRecepient: feeRecepient.publicKey,
                srcFeeDestination: null,
                dstFeeDestination: feeMint2Destination.address,
                systemProgram: web3.SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([lp])
            .rpc();

        console.log(`confirm tx: ${tx2}`);

        let feeMint1 = amount.mul(new BN(1000)).div(new BN(10000));
        let feeMint2 = amountBack.mul(new BN(1000)).div(new BN(10000));

        let userMint1BalAfter = new BN(
            (await getAccount(connection, userAtaTokenMint1Account.address)).amount.toString(),
        );
        let userMint2BalAfter = new BN(
            (await getAccount(connection, userAtaTokenMint2Account.address)).amount.toString(),
        );
        let userSOLBalAfter = new BN(await connection.getBalance(user.publicKey));
        expect(userMint1BalBefore.toString()).to.be.equal(userMint1BalAfter.toString());
        expect(userMint2BalAfter.sub(userMint2BalBefore).toString()).to.be.eq(amountBack.sub(feeMint2).toString());
        expect(userSOLBalBefore.sub(userSOLBalAfter).toString()).to.be.eq(amount.toString());

        let lpMint1BalAfter = new BN((await getAccount(connection, lpAtaTokenMint1Account.address)).amount.toString());
        let lpMint2BalAfter = new BN((await getAccount(connection, lpAtaTokenMint2Account.address)).amount.toString());
        let lpSOLBalAfter = new BN(await connection.getBalance(lp.publicKey));
        expect(lpMint1BalBefore.toString()).to.be.equal(lpMint1BalAfter.toString());
        expect(lpMint2BalBefore.sub(lpMint2BalAfter).toString()).to.be.eq(amountBack.toString());
        expect(lpSOLBalAfter.sub(lpSOLBalBefore).toString()).to.be.eq(amount.sub(feeMint1).toString());

        let feeRecepientMint1BalAfter = new BN(
            (await getAccount(connection, feeMint1Destination.address)).amount.toString(),
        );
        let feeRecepientMint2BalAfter = new BN(
            (await getAccount(connection, feeMint2Destination.address)).amount.toString(),
        );
        let feeRecepientSOLBalAfter = new BN(await connection.getBalance(feeRecepient.publicKey));
        expect(feeRecepientMint1BalAfter.toString()).to.be.equal(feeRecepientMint1BalBefore.toString());
        expect(feeRecepientMint2BalAfter.sub(feeRecepientMint2BalBefore).toString()).to.be.eq(feeMint2.toString());
        expect(feeRecepientSOLBalAfter.sub(feeRecepientSOLBalBefore).toString()).to.be.eq(feeMint1.toString());
    });

    it("swap SPL A Token <-> SOL", async () => {
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

        let stepTime = 5;

        let lock: Lock = {
            agreementReachedTime: new BN(agreementReachedTime),
            stepTime: new BN(stepTime),
        };
        console.log(`lock: ${JSON.stringify(lock)}`);

        // zero public key to indicate native token SOL
        const zeroPublicKey = new web3.PublicKey(new Uint8Array(32).fill(0));
        console.log(`zero public key: ${zeroPublicKey.toBase58()}`);

        console.log(`========== prepare ==========`);
        let uuid1 = generateUuidSwap(
            user.publicKey,
            lp.publicKey,
            mint1,
            amount,
            zeroPublicKey,
            amountBack,
            lock.agreementReachedTime,
            lock.stepTime,
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
        tx = await program.methods
            .prepare(uuid1, amount, amountBack, lock, memo)
            .accounts({
                payer: user.publicKey,
                from: user.publicKey,
                to: lp.publicKey,
                srcToken: mint1,
                source: userAtaTokenMint1Account.address,
                dstToken: null,
                escrow: escrow1,
                escrowAta: escrow1AtaTokenAccount,
                adminSettings: adminSettings,
                srcTokenSettings: null,
                dstTokenSettings: null,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: web3.SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([user])
            .rpc();
        console.log(`transfer out tx: ${tx}`);

        console.log(`========== confirm ==========`);

        // user token mint2 ata address
        let userAtaTokenMint2Account = await getOrCreateAssociatedTokenAccount(
            connection,
            payer,
            mint2,
            user.publicKey,
        );

        // lp token mint1 ata address
        let lpAtaTokenMint1Account = await getOrCreateAssociatedTokenAccount(connection, payer, mint1, lp.publicKey);

        // fee recepient mint2 ata address
        let feeMint1Destination = await getOrCreateAssociatedTokenAccount(
            connection,
            payer,
            mint1,
            feeRecepient.publicKey,
        );

        // fee recepient mint2 ata address
        let feeMint2Destination = await getOrCreateAssociatedTokenAccount(
            connection,
            payer,
            mint2,
            feeRecepient.publicKey,
        );

        // lp confirm the swap initiated by user (prepare)
        const tx2 = await program.methods
            .confirm(uuid1)
            .accounts({
                payer: lp.publicKey,
                from: user.publicKey,
                fromDestination: null,
                to: lp.publicKey,
                toSource: null,
                toDestination: lpAtaTokenMint1Account.address,
                escrow: escrow1,
                escrowAta: escrow1AtaTokenAccount,
                adminSettings: adminSettings,
                feeRecepient: feeRecepient.publicKey,
                srcFeeDestination: feeMint1Destination.address,
                dstFeeDestination: null,
                systemProgram: web3.SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([lp])
            .rpc();

        console.log(`confirm tx: ${tx2}`);

        let feeMint1 = amount.mul(new BN(1000)).div(new BN(10000));
        let feeMint2 = amountBack.mul(new BN(1000)).div(new BN(10000));

        let userMint1BalAfter = new BN(
            (await getAccount(connection, userAtaTokenMint1Account.address)).amount.toString(),
        );
        let userMint2BalAfter = new BN(
            (await getAccount(connection, userAtaTokenMint2Account.address)).amount.toString(),
        );
        let userSOLBalAfter = new BN(await connection.getBalance(user.publicKey));
        expect(userMint1BalBefore.sub(userMint1BalAfter).toString()).to.be.eq(amount.toString());
        expect(userMint2BalBefore.toString()).to.be.equal(userMint2BalAfter.toString());
        expect(userSOLBalAfter.sub(userSOLBalBefore).toString()).to.be.eq(amountBack.sub(feeMint2).toString());

        let lpMint1BalAfter = new BN((await getAccount(connection, lpAtaTokenMint1Account.address)).amount.toString());
        let lpMint2BalAfter = new BN((await getAccount(connection, lpAtaTokenMint2Account.address)).amount.toString());
        let lpSOLBalAfter = new BN(await connection.getBalance(lp.publicKey));
        expect(lpMint1BalAfter.sub(lpMint1BalBefore).toString()).to.be.eq(amount.sub(feeMint1).toString());
        expect(lpMint2BalBefore.toString()).to.be.equal(lpMint2BalAfter.toString());
        expect(lpSOLBalBefore.sub(lpSOLBalAfter).toString()).to.be.eq(amountBack.toString());

        let feeRecepientMint1BalAfter = new BN(
            (await getAccount(connection, feeMint1Destination.address)).amount.toString(),
        );
        let feeRecepientMint2BalAfter = new BN(
            (await getAccount(connection, feeMint2Destination.address)).amount.toString(),
        );
        let feeRecepientSOLBalAfter = new BN(await connection.getBalance(feeRecepient.publicKey));
        expect(feeRecepientMint1BalAfter.sub(feeRecepientMint1BalBefore).toString()).to.be.eq(feeMint1.toString());
        expect(feeRecepientMint2BalAfter.toString()).to.be.equal(feeRecepientMint2BalBefore.toString());
        expect(feeRecepientSOLBalAfter.sub(feeRecepientSOLBalBefore).toString()).to.be.eq(feeMint2.toString());
    });

    it("refund SPL A Token <-> SPL B Token", async () => {
        let slot = await connection.getSlot();
        let agreementReachedTime = await connection.getBlockTime(slot);
        if (!agreementReachedTime) {
            throw new Error("agreementReachedTime is null");
        }

        let stepTime = 1;

        let lock: Lock = {
            agreementReachedTime: new BN(agreementReachedTime),
            stepTime: new BN(stepTime),
        };
        console.log(`lock: ${JSON.stringify(lock)}`);

        console.log(`========== prepare ==========`);
        let uuid1 = generateUuidSwap(
            user.publicKey,
            lp.publicKey,
            mint1,
            amount,
            mint2,
            amountBack,
            lock.agreementReachedTime,
            lock.stepTime,
        );
        console.log(`generate uuid1: ${uuid1}`);

        // calculate escrow account address offchain without create it
        let [escrow1] = web3.PublicKey.findProgramAddressSync([Buffer.from(uuid1)], program.programId);
        console.log(`offchain escrow1: ${escrow1}`);

        // calculate escrowAtaTokenAccount account address offchain without create it
        let escrow1AtaTokenAccount = getAssociatedTokenAddressSync(mint1, escrow1, true);
        console.log(`offchain escrow1 ata ${escrow1AtaTokenAccount}`);

        let memo = Buffer.from([1, 2, 3, 4, 5]);

        tx = await program.methods
            .prepare(uuid1, amount, amountBack, lock, memo)
            .accounts({
                payer: user.publicKey,
                from: user.publicKey,
                to: lp.publicKey,
                srcToken: mint1,
                source: userAtaTokenMint1Account.address,
                dstToken: mint2,
                escrow: escrow1,
                escrowAta: escrow1AtaTokenAccount,
                adminSettings: adminSettings,
                srcTokenSettings: null,
                dstTokenSettings: null,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: web3.SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([user])
            .rpc();
        console.log(`transfer out tx: ${tx}`);

        console.log(`========== refund ==========`);

        try {
            await program.methods
            .refund(uuid1)
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
            console.log(`cannot refund before the refund window`);
            console.log(`========== error ==========`);
            console.log((err as AnchorError).logs);
            expect((err as AnchorError).logs).not.to.be.empty;
        }

        let refundTime = lock.agreementReachedTime.add(lock.stepTime.mul(new BN(2))).add(new BN(1));
        console.log(`wait until the refund window: ${refundTime.toNumber()}`);
        while (true) {
            let slot = await connection.getSlot();
            let currentTime = await connection.getBlockTime(slot);
            if (!currentTime) {
                throw new Error("currentTime is null");
            }
            console.log(`currentTime: ${currentTime}`);
            if (currentTime >= refundTime.toNumber()) {
                break;
            }
            await sleep(1000);
        }

        const tx2 = await program.methods
            .refund(uuid1)
            .accounts({
                from: user.publicKey,
                source: userAtaTokenMint1Account.address,
                escrow: escrow1,
                escrowAta: escrow1AtaTokenAccount,
                systemProgram: web3.SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .rpc();

        console.log(`refund tx: ${tx2}`);
    });

    it("refund SOL <-> SPL B Token", async () => {
        let slot = await connection.getSlot();
        let agreementReachedTime = await connection.getBlockTime(slot);
        if (!agreementReachedTime) {
            throw new Error("agreementReachedTime is null");
        }

        let stepTime = 1;

        let lock: Lock = {
            agreementReachedTime: new BN(agreementReachedTime),
            stepTime: new BN(stepTime),
        };
        console.log(`lock: ${JSON.stringify(lock)}`);

        // zero public key to indicate native token SOL
        const zeroPublicKey = new web3.PublicKey(new Uint8Array(32).fill(0));
        console.log(`zero public key: ${zeroPublicKey.toBase58()}`);

        console.log(`========== prepare ==========`);
        let uuid1 = generateUuidSwap(
            user.publicKey,
            lp.publicKey,
            mint1,
            amount,
            zeroPublicKey,
            amountBack,
            lock.agreementReachedTime,
            lock.stepTime,
        );
        console.log(`generate uuid1: ${uuid1}`);

        // calculate escrow account address offchain without create it
        let [escrow1] = web3.PublicKey.findProgramAddressSync([Buffer.from(uuid1)], program.programId);
        console.log(`offchain escrow1: ${escrow1}`);

        // calculate escrowAtaTokenAccount account address offchain without create it
        let escrow1AtaTokenAccount = getAssociatedTokenAddressSync(mint1, escrow1, true);
        console.log(`offchain escrow1 ata ${escrow1AtaTokenAccount}`);

        let memo = Buffer.from([1, 2, 3, 4, 5]);

        tx = await program.methods
            .prepare(uuid1, amount, amountBack, lock, memo)
            .accounts({
                payer: user.publicKey,
                from: user.publicKey,
                to: lp.publicKey,
                srcToken: null,
                source: null,
                dstToken: mint2,
                escrow: escrow1,
                escrowAta: null,
                adminSettings: adminSettings,
                srcTokenSettings: null,
                dstTokenSettings: null,
                associatedTokenProgram: null,
                systemProgram: web3.SystemProgram.programId,
                tokenProgram: null,
            })
            .signers([user])
            .rpc();
        console.log(`transfer out tx: ${tx}`);

        console.log(`========== refund ==========`);

        let refundTime = lock.agreementReachedTime.add(lock.stepTime.mul(new BN(2))).add(new BN(1));
        console.log(`wait until the refund window: ${refundTime.toNumber()}`);
        while (true) {
            let slot = await connection.getSlot();
            let currentTime = await connection.getBlockTime(slot);
            if (!currentTime) {
                throw new Error("currentTime is null");
            }
            console.log(`currentTime: ${currentTime}`);
            if (currentTime >= refundTime.toNumber()) {
                break;
            }
            await sleep(1000);
        }

        const tx2 = await program.methods
            .refund(uuid1)
            .accounts({
                from: user.publicKey,
                source: null,
                escrow: escrow1,
                escrowAta: null,
                systemProgram: web3.SystemProgram.programId,
                tokenProgram: null,
            })
            .rpc();

        console.log(`refund tx: ${tx2}`);
    });

    it("set token max fee", async () => {
        let feeRecepientMint1Before = new BN(
            (await getAccount(connection, feeMint1Destination.address)).amount.toString(),
        );

        let feeRecepientMint2Before = new BN(
            (await getAccount(connection, feeMint2Destination.address)).amount.toString(),
        );

        let maxFeeForMint1 = new BN(50);
        let tx = await program.methods
            .setMaxFeeForToken(mint1, maxFeeForMint1)
            .accounts({
                payer: payer.publicKey,
                admin: newAdmin.publicKey,
                adminSettings: adminSettings,
                tokenSettings: mint1Settings,
                systemProgram: web3.SystemProgram.programId,
            })
            .signers([payer, newAdmin])
            .rpc();
        console.log(`set src token max fee tx: ${tx}`);

        let maxFeeForMint2 = new BN(30);
        tx = await program.methods
            .setMaxFeeForToken(mint2, maxFeeForMint2)
            .accounts({
                payer: payer.publicKey,
                admin: newAdmin.publicKey,
                adminSettings: adminSettings,
                tokenSettings: mint2Settings,
                systemProgram: web3.SystemProgram.programId,
            })
            .signers([payer, newAdmin])
            .rpc();
        console.log(`set dst token max fee tx: ${tx}`);

        let slot = await connection.getSlot();
        let agreementReachedTime = await connection.getBlockTime(slot);
        if (!agreementReachedTime) {
            throw new Error("agreementReachedTime is null");
        }

        let stepTime = 5;

        let lock: Lock = {
            agreementReachedTime: new BN(agreementReachedTime),
            stepTime: new BN(stepTime),
        };
        console.log(`lock: ${JSON.stringify(lock)}`);

        let uuid1 = generateUuidSwap(
            user.publicKey,
            lp.publicKey,
            mint1,
            amount,
            mint2,
            amountBack,
            lock.agreementReachedTime,
            lock.stepTime,
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
            .prepare(uuid1, amount, amountBack, lock, memo)
            .accounts({
                payer: user.publicKey,
                from: user.publicKey,
                to: lp.publicKey,
                srcToken: mint1,
                source: userAtaTokenMint1Account.address,
                dstToken: mint2,
                escrow: escrow1,
                escrowAta: escrow1AtaTokenAccount,
                adminSettings: adminSettings,
                srcTokenSettings: mint1Settings,
                dstTokenSettings: mint2Settings,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: web3.SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([user])
            .rpc();

        console.log(`transfer out tx: ${tx}`);

        const tx2 = await program.methods
            .confirm(uuid1)
            .accounts({
                payer: lp.publicKey,
                from: user.publicKey,
                fromDestination: userAtaTokenMint2Account.address,
                to: lp.publicKey,
                toSource: lpAtaTokenMint2Account.address,
                toDestination: lpAtaTokenMint1Account.address,
                escrow: escrow1,
                escrowAta: escrow1AtaTokenAccount,
                adminSettings: adminSettings,
                feeRecepient: feeRecepient.publicKey,
                srcFeeDestination: feeMint1Destination.address,
                dstFeeDestination: feeMint2Destination.address,
                systemProgram: web3.SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([lp])
            .rpc();

        console.log(`confirm tx: ${tx2}`);

        let feeRecepientMint1After = new BN(
            (await getAccount(connection, feeMint1Destination.address)).amount.toString(),
        );

        expect(feeRecepientMint1After.sub(feeRecepientMint1Before).toString()).to.be.eq(maxFeeForMint1.toString());

        let feeRecepientMint2After = new BN(
            (await getAccount(connection, feeMint2Destination.address)).amount.toString(),
        );

        expect(feeRecepientMint2After.sub(feeRecepientMint2Before).toString()).to.be.eq(maxFeeForMint2.toString());
    });

    it("set src token SOL max fee", async () => {
        let feeRecepientSOLBefore = new BN(await connection.getBalance(feeRecepient.publicKey));

        const zeroPublicKey = new web3.PublicKey(new Uint8Array(32).fill(0));
        console.log(`zero public key: ${zeroPublicKey.toBase58()}`);

        let [solSettings] = web3.PublicKey.findProgramAddressSync(
            [Buffer.from("token"), zeroPublicKey.toBytes()],
            program.programId,
        );

        let maxFeeForMint1 = new BN(50);
        let tx = await program.methods
            .setMaxFeeForToken(zeroPublicKey, maxFeeForMint1)
            .accounts({
                payer: payer.publicKey,
                admin: newAdmin.publicKey,
                adminSettings: adminSettings,
                tokenSettings: solSettings,
                systemProgram: web3.SystemProgram.programId,
            })
            .signers([payer, newAdmin])
            .rpc();
        console.log(`set SOL max fee tx: ${tx}`);

        let slot = await connection.getSlot();
        let agreementReachedTime = await connection.getBlockTime(slot);
        if (!agreementReachedTime) {
            throw new Error("agreementReachedTime is null");
        }

        let stepTime = 5;

        let lock: Lock = {
            agreementReachedTime: new BN(agreementReachedTime),
            stepTime: new BN(stepTime),
        };
        console.log(`lock: ${JSON.stringify(lock)}`);

        let uuid1 = generateUuidSwap(
            user.publicKey,
            lp.publicKey,
            zeroPublicKey,
            amount,
            mint2,
            amountBack,
            lock.agreementReachedTime,
            lock.stepTime,
        );
        console.log(`generate uuid1: ${uuid1}`);

        // calculate escrow account address offchain without create it
        let [escrow1] = web3.PublicKey.findProgramAddressSync([Buffer.from(uuid1)], program.programId);
        console.log(`offchain escrow1: ${escrow1}`);

        let memo = Buffer.from([1, 2, 3, 4, 5]);

        // transfer out
        tx = await program.methods
            .prepare(uuid1, amount, amountBack, lock, memo)
            .accounts({
                payer: user.publicKey,
                from: user.publicKey,
                to: lp.publicKey,
                srcToken: null,
                source: null,
                dstToken: mint2,
                escrow: escrow1,
                escrowAta: null,
                adminSettings: adminSettings,
                srcTokenSettings: solSettings,
                dstTokenSettings: null,
                associatedTokenProgram: null,
                systemProgram: web3.SystemProgram.programId,
                tokenProgram: null,
            })
            .signers([user])
            .rpc();

        console.log(`transfer out tx: ${tx}`);

        const tx2 = await program.methods
            .confirm(uuid1)
            .accounts({
                payer: lp.publicKey,
                from: user.publicKey,
                fromDestination: userAtaTokenMint2Account.address,
                to: lp.publicKey,
                toSource: lpAtaTokenMint2Account.address,
                toDestination: null,
                escrow: escrow1,
                escrowAta: null,
                adminSettings: adminSettings,
                feeRecepient: feeRecepient.publicKey,
                srcFeeDestination: null,
                dstFeeDestination: feeMint2Destination.address,
                systemProgram: web3.SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([lp])
            .rpc();

        console.log(`confirm tx: ${tx2}`);

        let feeRecepientSOLAfter = new BN(await connection.getBalance(feeRecepient.publicKey));

        expect(feeRecepientSOLAfter.sub(feeRecepientSOLBefore).toString()).to.be.eq(maxFeeForMint1.toString());
    });

    it("set dst token SOL max fee", async () => {
        let feeRecepientSOLBefore = new BN(await connection.getBalance(feeRecepient.publicKey));

        const zeroPublicKey = new web3.PublicKey(new Uint8Array(32).fill(0));
        console.log(`zero public key: ${zeroPublicKey.toBase58()}`);

        let [solSettings] = web3.PublicKey.findProgramAddressSync(
            [Buffer.from("token"), zeroPublicKey.toBytes()],
            program.programId,
        );

        let maxFeeForMint2 = new BN(50);
        // sol token settings was set at test [set src token SOL max fee]

        let slot = await connection.getSlot();
        let agreementReachedTime = await connection.getBlockTime(slot);
        if (!agreementReachedTime) {
            throw new Error("agreementReachedTime is null");
        }

        let stepTime = 5;

        let lock: Lock = {
            agreementReachedTime: new BN(agreementReachedTime),
            stepTime: new BN(stepTime),
        };
        console.log(`lock: ${JSON.stringify(lock)}`);

        let uuid1 = generateUuidSwap(
            user.publicKey,
            lp.publicKey,
            mint1,
            amount,
            zeroPublicKey,
            amountBack,
            lock.agreementReachedTime,
            lock.stepTime,
        );
        console.log(`generate uuid1: ${uuid1}`);

        let [escrow1] = web3.PublicKey.findProgramAddressSync([Buffer.from(uuid1)], program.programId);
        console.log(`offchain escrow1: ${escrow1}`);

        let escrow1AtaTokenAccount = getAssociatedTokenAddressSync(mint1, escrow1, true);
        console.log(`offchain escrow1 ata ${escrow1AtaTokenAccount}`);

        let memo = Buffer.from([1, 2, 3, 4, 5]);

        // transfer out
        tx = await program.methods
            .prepare(uuid1, amount, amountBack, lock, memo)
            .accounts({
                payer: user.publicKey,
                from: user.publicKey,
                to: lp.publicKey,
                srcToken: mint1,
                source: userAtaTokenMint1Account.address,
                dstToken: null,
                escrow: escrow1,
                escrowAta: escrow1AtaTokenAccount,
                adminSettings: adminSettings,
                srcTokenSettings: null,
                dstTokenSettings: solSettings,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: web3.SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([user])
            .rpc();

        console.log(`transfer out tx: ${tx}`);

        const tx2 = await program.methods
            .confirm(uuid1)
            .accounts({
                payer: lp.publicKey,
                from: user.publicKey,
                fromDestination: null,
                to: lp.publicKey,
                toSource: null,
                toDestination: lpAtaTokenMint1Account.address,
                escrow: escrow1,
                escrowAta: escrow1AtaTokenAccount,
                adminSettings: adminSettings,
                feeRecepient: feeRecepient.publicKey,
                srcFeeDestination: feeMint1Destination.address,
                dstFeeDestination: null,
                systemProgram: web3.SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([lp])
            .rpc();

        console.log(`confirm tx: ${tx2}`);

        let feeRecepientSOLAfter = new BN(await connection.getBalance(feeRecepient.publicKey));

        expect(feeRecepientSOLAfter.sub(feeRecepientSOLBefore).toString()).to.be.eq(maxFeeForMint2.toString());
    });

    it("cannot call prepare after deadline", async () => {
        let slot = await connection.getSlot();
        let agreementReachedTime = await connection.getBlockTime(slot);
        if (!agreementReachedTime) {
            throw new Error("agreementReachedTime is null");
        }

        let stepTime = 1;

        let lock: Lock = {
            agreementReachedTime: new BN(agreementReachedTime),
            stepTime: new BN(stepTime),
        };
        console.log(`lock: ${JSON.stringify(lock)}`);

        let uuid1 = generateUuidSwap(
            user.publicKey,
            lp.publicKey,
            mint1,
            amount,
            mint2,
            amountBack,
            lock.agreementReachedTime,
            lock.stepTime,
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
            tx = await program.methods
                .prepare(uuid1, amount, amountBack, lock, memo)
                .accounts({
                    payer: user.publicKey,
                    from: user.publicKey,
                    to: lp.publicKey,
                    srcToken: mint1,
                    source: userAtaTokenMint1Account.address,
                    dstToken: mint2,
                    escrow: escrow1,
                    escrowAta: escrow1AtaTokenAccount,
                    adminSettings: adminSettings,
                    srcTokenSettings: null,
                    dstTokenSettings: null,
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

    it("cannot call prepare with amount 0", async () => {
        let slot = await connection.getSlot();
        let agreementReachedTime = await connection.getBlockTime(slot);
        if (!agreementReachedTime) {
            throw new Error("agreementReachedTime is null");
        }

        let stepTime = 5;

        let lock: Lock = {
            agreementReachedTime: new BN(agreementReachedTime),
            stepTime: new BN(stepTime),
        };
        console.log(`lock: ${JSON.stringify(lock)}`);

        let uuid1 = generateUuidSwap(
            user.publicKey,
            lp.publicKey,
            mint1,
            amount,
            mint2,
            amountBack,
            lock.agreementReachedTime,
            lock.stepTime,
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
            await program.methods;
            tx = await program.methods
                .prepare(uuid1, new BN(0), new BN(0), lock, memo)
                .accounts({
                    payer: user.publicKey,
                    from: user.publicKey,
                    to: lp.publicKey,
                    srcToken: mint1,
                    source: userAtaTokenMint1Account.address,
                    dstToken: mint2,
                    escrow: escrow1,
                    escrowAta: escrow1AtaTokenAccount,
                    adminSettings: adminSettings,
                    srcTokenSettings: null,
                    dstTokenSettings: null,
                    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                    systemProgram: web3.SystemProgram.programId,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([user])
                .rpc();
        } catch (err: any) {
            console.log(`if the token amount is 0, it should throw error`);
            console.log(`========== error ==========`);
            console.log((err as AnchorError).logs);
            expect((err as AnchorError).logs).not.to.be.empty;
        }
    });
});
