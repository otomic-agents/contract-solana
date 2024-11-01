import crypto from "crypto";
import * as anchor from "@coral-xyz/anchor";
import { Program, web3, AnchorError } from "@coral-xyz/anchor";
import { ObridgeSol } from "../target/types/obridge_sol";
import { keccak_256 } from "@noble/hashes/sha3";
import BN from "bn.js";
import { createAccountOnChain, airdropSOL, transferSOL, generateUuidSol, sleep } from "./helper";
import { expect } from "chai";

type Lock = {
    hash: Array<number>;
    agreementReachedTime: BN;
    expectedSingleStepTime: BN;
    tolerantSingleStepTime: BN;
    earliestRefundTime: BN;
};

describe("SOL <-> SOL", () => {
    // Configure the client to use the local cluster.
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const connection = provider.connection;
    console.log(`network connected: ${connection.rpcEndpoint}`);
    const program = anchor.workspace.ObridgeSol as Program<ObridgeSol>;
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
    let solAmount: BN;

    let lp: web3.Keypair;
    let solAmountBack: BN;

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

        solAmount = new BN(2 * 10 ** 9);
        user = await createAccountOnChain(connection, payer);
        await transferSOL(connection, payer, user.publicKey, 20 * 10 ** 9);
        const userBal = await connection.getBalance(user.publicKey);
        console.log(`user: ${user.publicKey} balance: ${userBal / web3.LAMPORTS_PER_SOL} SOL`);

        solAmountBack = new BN(2 * 10 ** 9);
        lp = await createAccountOnChain(connection, payer);
        await transferSOL(connection, payer, lp.publicKey, 20 * 10 ** 9);
        const lpBal = await connection.getBalance(lp.publicKey);
        console.log(`lp: ${lp.publicKey} balance: ${lpBal / web3.LAMPORTS_PER_SOL} SOL`);

        [adminSettings] = web3.PublicKey.findProgramAddressSync([Buffer.from("settings")], program.programId);
        console.log(`offchain adminSettings: ${adminSettings.toBase58()}`);

        let _preimage = new Uint8Array(32);
        preimage = Array.from(crypto.getRandomValues(_preimage));
        hashlock = Array.from(keccak_256(Buffer.from(preimage)));

        isOut = true;
        isIn = false;
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
        let uuid1 = generateUuidSol(
            user.publicKey,
            lp.publicKey,
            lock.hash,
            lock.agreementReachedTime,
            lock.expectedSingleStepTime,
            lock.tolerantSingleStepTime,
            lock.earliestRefundTime,
            solAmount,
        );
        console.log(`generate uuid1: ${uuid1}`);

        // calculate escrow account address offchain without create it
        let [escrow1] = web3.PublicKey.findProgramAddressSync([Buffer.from(uuid1)], program.programId);
        console.log(`offchain escrow1: ${escrow1}`);

        let memo = Buffer.from([1, 2, 3, 4, 5]);

        // got error before initialize program
        try {
            await program.methods
                .prepare(uuid1, lp.publicKey, solAmount, lock, isOut, memo)
                .accounts({
                    payer: user.publicKey,
                    from: user.publicKey,
                    escrow: escrow1,
                    adminSettings: adminSettings,
                    systemProgram: web3.SystemProgram.programId,
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

        let feeSOL = solAmountBack.mul(new BN(1000)).div(new BN(10000));

        // transfer out
        tx = await program.methods
            .prepare(uuid1, lp.publicKey, solAmount, lock, isOut, memo)
            .accounts({
                payer: user.publicKey,
                from: user.publicKey,
                escrow: escrow1,
                adminSettings: adminSettings,
                systemProgram: web3.SystemProgram.programId,
            })
            .signers([user])
            .rpc();

        console.log(`transfer out tx: ${tx}`);

        // try to use same uuid for wrong test
        try {
            await program.methods
                .prepare(uuid1, lp.publicKey, solAmount, lock, isOut, memo)
                .accounts({
                    payer: user.publicKey,
                    from: user.publicKey,
                    escrow: escrow1,
                    adminSettings: adminSettings,
                    systemProgram: web3.SystemProgram.programId,
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
        let uuid2 = generateUuidSol(
            lp.publicKey,
            user.publicKey,
            lock.hash,
            lock.agreementReachedTime,
            lock.expectedSingleStepTime,
            lock.tolerantSingleStepTime,
            lock.earliestRefundTime,
            solAmountBack,
        );
        console.log(`generate uuid2: ${uuid2}`);

        // calculate escrow account address offchain without create it
        let [escrow2] = web3.PublicKey.findProgramAddressSync([Buffer.from(uuid2)], program.programId);
        console.log(`offchain escrow2: ${escrow2}`);

        // lp response to the swap initiated by user (transfer in)
        const tx2 = await program.methods
            .prepare(uuid2, user.publicKey, solAmountBack, lock, isIn, memo)
            .accounts({
                payer: lp.publicKey,
                from: lp.publicKey,
                escrow: escrow2,
                adminSettings: adminSettings,
                systemProgram: web3.SystemProgram.programId,
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

        // user confirm the swap (transfer out)
        const tx3 = await program.methods
            .confirm(uuid1, preimage, isOut)
            .accounts({
                payer: user.publicKey,
                from: user.publicKey,
                to: lp.publicKey,
                escrow: escrow1,
                adminSettings: adminSettings,
                feeRecepient: feeRecepient.publicKey,
                systemProgram: web3.SystemProgram.programId,
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
                escrow: escrow2,
                adminSettings: adminSettings,
                feeRecepient: feeRecepient.publicKey,
                systemProgram: web3.SystemProgram.programId,
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

    it("cannot call initiate after deadline for SOL swap", async () => {
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

        let uuid1 = generateUuidSol(
            user.publicKey,
            lp.publicKey,
            lock.hash,
            lock.agreementReachedTime,
            lock.expectedSingleStepTime,
            lock.tolerantSingleStepTime,
            lock.earliestRefundTime,
            solAmount,
        );
        console.log(`generate uuid1: ${uuid1}`);

        // calculate escrow account address offchain without create it
        let [escrow1] = web3.PublicKey.findProgramAddressSync([Buffer.from(uuid1)], program.programId);
        console.log(`offchain escrow1: ${escrow1}`);

        let memo = Buffer.from([1, 2, 3, 4, 5]);

        // sleep until the transfer out deadline
        await sleep(5000);

        try {
            await program.methods
                .prepare(uuid1, lp.publicKey, solAmount, lock, isOut, memo)
                .accounts({
                    payer: user.publicKey,
                    from: user.publicKey,
                    escrow: escrow1,
                    adminSettings: adminSettings,
                    systemProgram: web3.SystemProgram.programId,
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

    it("cannot call initiate with amount 0 for SOL swap", async () => {
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

        solAmount = new BN(0);

        let uuid1 = generateUuidSol(
            user.publicKey,
            lp.publicKey,
            lock.hash,
            lock.agreementReachedTime,
            lock.expectedSingleStepTime,
            lock.tolerantSingleStepTime,
            lock.earliestRefundTime,
            solAmount,
        );
        console.log(`generate uuid1: ${uuid1}`);

        // calculate escrow account address offchain without create it
        let [escrow1] = web3.PublicKey.findProgramAddressSync([Buffer.from(uuid1)], program.programId);
        console.log(`offchain escrow1: ${escrow1}`);

        let memo = Buffer.from([1, 2, 3, 4, 5]);

        try {
            await program.methods
                .prepare(uuid1, lp.publicKey, solAmount, lock, isOut, memo)
                .accounts({
                    payer: user.publicKey,
                    from: user.publicKey,
                    escrow: escrow1,
                    adminSettings: adminSettings,
                    systemProgram: web3.SystemProgram.programId,
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

        let uuid1 = generateUuidSol(
            user.publicKey,
            lp.publicKey,
            lock.hash,
            lock.agreementReachedTime,
            lock.expectedSingleStepTime,
            lock.tolerantSingleStepTime,
            lock.earliestRefundTime,
            solAmount,
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
            .prepare(uuid1, lp.publicKey, solAmount, lock, isOut, memo)
            .accounts({
                payer: user.publicKey,
                from: user.publicKey,
                escrow: escrow1,
                adminSettings: adminSettings,
                systemProgram: web3.SystemProgram.programId,
            })
            .signers([user, user])
            .rpc();

        console.log(`transfer out tx: ${tx}`);

        console.log(`========== transfer in ==========`);
        let uuid2 = generateUuidSol(
            lp.publicKey,
            user.publicKey,
            lock.hash,
            lock.agreementReachedTime,
            lock.expectedSingleStepTime,
            lock.tolerantSingleStepTime,
            lock.earliestRefundTime,
            solAmountBack,
        );
        console.log(`generate uuid2: ${uuid2}`);

        // calculate escrow account address offchain without create it
        let [escrow2] = web3.PublicKey.findProgramAddressSync([Buffer.from(uuid2)], program.programId);
        console.log(`offchain escrow2: ${escrow2}`);

        // lp response to the swap initiated by user (transfer in)
        const tx2 = await program.methods
            .prepare(uuid2, user.publicKey, solAmountBack, lock, isIn, memo)
            .accounts({
                payer: lp.publicKey,
                from: lp.publicKey,
                escrow: escrow2,
                adminSettings: adminSettings,
                systemProgram: web3.SystemProgram.programId,
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
                    escrow: escrow1,
                    systemProgram: web3.SystemProgram.programId,
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
                escrow: escrow1,
                systemProgram: web3.SystemProgram.programId,
            })
            .rpc();

        console.log(`user refund transfer out tx: ${tx5}`);

        console.log(`========== refund transfer in ==========`);
        // lp refund the swap (transfer in)
        const tx6 = await program.methods
            .refund(uuid2, isIn)
            .accounts({
                from: lp.publicKey,
                escrow: escrow2,
                systemProgram: web3.SystemProgram.programId,
            })
            .rpc();

        console.log(`lp refund transfer in tx: ${tx6}`);

        let userSOLBalAfter = new BN(await connection.getBalance(user.publicKey));
        expect(userSOLBalBefore.toNumber()).to.be.eq(userSOLBalAfter.toNumber());

        let lpSOLBalAfter = new BN(await connection.getBalance(lp.publicKey));
        expect(lpSOLBalBefore.toNumber()).to.be.eq(lpSOLBalAfter.toNumber());
    });

    it("nonexisting account test for SOL swap", async () => {
        // create lp offchain and see what happens
        console.log(`========== before swap ==========`);
        lp = web3.Keypair.generate();
        const lpBal = await connection.getBalance(lp.publicKey);
        console.log(`lp: ${lp.publicKey} balance: ${lpBal / web3.LAMPORTS_PER_SOL} SOL`);

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

        console.log(`========== transfer out ==========`);
        let uuid1 = generateUuidSol(
            user.publicKey,
            lp.publicKey,
            lock.hash,
            lock.agreementReachedTime,
            lock.expectedSingleStepTime,
            lock.tolerantSingleStepTime,
            lock.earliestRefundTime,
            solAmount,
        );
        console.log(`generate uuid1: ${uuid1}`);

        // calculate escrow account address offchain without create it
        let [escrow1] = web3.PublicKey.findProgramAddressSync([Buffer.from(uuid1)], program.programId);
        console.log(`offchain escrow1: ${escrow1}`);

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
            .prepare(uuid1, lp.publicKey, solAmount, lock, isOut, memo)
            .accounts({
                payer: user.publicKey,
                from: user.publicKey,
                escrow: escrow1,
                adminSettings: adminSettings,
                systemProgram: web3.SystemProgram.programId,
            })
            .signers([user])
            .rpc();

        console.log(`transfer out tx: ${tx}`);

        console.log(`========== confirm transfer out ==========`);

        // user confirm the swap (transfer out)
        const tx3 = await program.methods
            .confirm(uuid1, preimage, isOut)
            .accounts({
                payer: user.publicKey,
                from: user.publicKey,
                to: lp.publicKey,
                escrow: escrow1,
                adminSettings: adminSettings,
                feeRecepient: feeRecepient.publicKey,
                systemProgram: web3.SystemProgram.programId,
            })
            .signers([user])
            .rpc();

        console.log(`confirm transfer out tx: ${tx3}`);

        console.log(`========== after swap ==========`);
        const lpAfter = await connection.getBalance(lp.publicKey);
        console.log(`lp: ${lp.publicKey} balance: ${lpAfter / web3.LAMPORTS_PER_SOL} SOL`);
        expect(lpAfter - lpBal).to.be.eq(solAmount.toNumber());
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
        let uuid1 = generateUuidSol(
            user.publicKey,
            lp.publicKey,
            lock.hash,
            lock.agreementReachedTime,
            lock.expectedSingleStepTime,
            lock.tolerantSingleStepTime,
            lock.earliestRefundTime,
            solAmount,
        );
        console.log(`generate uuid1: ${uuid1}`);

        // calculate escrow account address offchain without create it
        let [escrow1] = web3.PublicKey.findProgramAddressSync([Buffer.from(uuid1)], program.programId);
        console.log(`offchain escrow1: ${escrow1}`);

        let memo = Buffer.from([1, 2, 3, 4, 5]);

        // transfer out
        tx = await program.methods
            .prepare(uuid1, lp.publicKey, solAmount, lock, isOut, memo)
            .accounts({
                payer: user.publicKey,
                from: user.publicKey,
                escrow: escrow1,
                adminSettings: adminSettings,
                systemProgram: web3.SystemProgram.programId,
            })
            .signers([user])
            .rpc();

        console.log(`transfer out tx: ${tx}`);

        console.log(`========== transfer in ==========`);
        let uuid2 = generateUuidSol(
            lp.publicKey,
            user.publicKey,
            lock.hash,
            lock.agreementReachedTime,
            lock.expectedSingleStepTime,
            lock.tolerantSingleStepTime,
            lock.earliestRefundTime,
            solAmountBack,
        );
        console.log(`generate uuid2: ${uuid2}`);

        // calculate escrow account address offchain without create it
        let [escrow2] = web3.PublicKey.findProgramAddressSync([Buffer.from(uuid2)], program.programId);
        console.log(`offchain escrow2: ${escrow2}`);

        // lp response to the swap initiated by user (transfer in)
        const tx2 = await program.methods
            .prepare(uuid2, user.publicKey, solAmountBack, lock, isIn, memo)
            .accounts({
                payer: lp.publicKey,
                from: lp.publicKey,
                escrow: escrow2,
                adminSettings: adminSettings,
                systemProgram: web3.SystemProgram.programId,
            })
            .signers([lp])
            .rpc();

        console.log(`transfer in tx: ${tx2}`);

        console.log(`========== try to confirm transfer out by using confirm in function ==========`);

        // user cannot confirm the swap by using confirm in function
        try {
            const tx3 = await program.methods
                .confirm(uuid1, preimage, isIn)
                .accounts({
                    payer: user.publicKey,
                    from: user.publicKey,
                    to: lp.publicKey,
                    escrow: escrow1,
                    adminSettings: adminSettings,
                    feeRecepient: feeRecepient.publicKey,
                    systemProgram: web3.SystemProgram.programId,
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
