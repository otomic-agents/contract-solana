import {
    Connection,
    Keypair,
    PublicKey,
} from "@solana/web3.js";
import {
    BN
} from "@coral-xyz/anchor";
import {
    getAccount,
    TOKEN_PROGRAM_ID
} from "@solana/spl-token";
import { ObridgeService, Lock, ExtraData } from "../src/ObridgeService";
import {
    createAccountOnChain,
    createSPLTokenAndMintToUser,
    sleep
} from "./utils";

import "dotenv/config";

async function main() {
    const connection = new Connection("https://api.devnet.solana.com", "confirmed");
    const obridgeProgramId = new PublicKey("2Xii6vHBc47isGv7ecXXdzcJbsPbH5rbHTsYuvycByRu");
    const payerPrivateKey = process.env.PAYER_PRIVATE_KEY;
    if (!payerPrivateKey) {
        console.error('PAYER_PRIVATE_KEY is not set');
        return;
    }
    const payer = Keypair.fromSecretKey(Uint8Array.from(payerPrivateKey.split(',').map(s => parseInt(s))));
    const obSrv = new ObridgeService(connection, payer, obridgeProgramId);

    // setup
    console.log(`========== setup up ==========`);
    const user = await createAccountOnChain(connection, payer);
    console.log(`user: ${user.publicKey}`);
    const amount = 2 * 10 ** 9;
    let { mint: mint1, ataTokenAccount: userAtaTokenMint1Account } = await createSPLTokenAndMintToUser(connection, payer, user, amount);
    console.log(`create SPL token mint1 ${mint1} and user ${user.publicKey} ata account ${userAtaTokenMint1Account.address}`);
    userAtaTokenMint1Account = await getAccount(
        connection,
        userAtaTokenMint1Account.address
    );
    console.log(`user ata token mint1 account ${userAtaTokenMint1Account.address} balance: ${userAtaTokenMint1Account.amount}`);

    const lp = await createAccountOnChain(connection, payer);
    console.log(`lp: ${lp.publicKey}`);
    const amountBack = 5 * 10 ** 9;
    let { mint: mint2, ataTokenAccount: lpAtaTokenMint2Account } = await createSPLTokenAndMintToUser(connection, payer, lp, amountBack);
    console.log(`create SPL token mint2 ${mint2} and lp ${lp.publicKey} ata account ${lpAtaTokenMint2Account.address}`);
    lpAtaTokenMint2Account = await getAccount(
        connection,
        lpAtaTokenMint2Account.address
    );
    console.log(`lp ata token mint2 account ${lpAtaTokenMint2Account.address} balance: ${lpAtaTokenMint2Account.amount}`);

    let userLockPreimage = obSrv.getRandomBytes(32);
    let userHashLock = obSrv.getHashLock(userLockPreimage);
    let relayLockPreimage = obSrv.getRandomBytes(32);
    let relayHashLock = obSrv.getHashLock(relayLockPreimage);
    let agreementReachedTime = await obSrv.getCurOnChainTimestamp();
    if (!agreementReachedTime) {
        console.log("failed to get on-chain timestamp");
        return;
    }
    let stepTimelock = 5;


    // transfer Out
    console.log(`========== transfer out ==========`);
    let uuid1 = obSrv.getRandomBytes(16);

    let userLock: Lock = {
        hash: userHashLock,
        deadline: new BN(agreementReachedTime + 3 * stepTimelock)
    };
    let relayLock: Lock = {
        hash: relayHashLock,
        deadline: new BN(agreementReachedTime + 6 * stepTimelock)
    };

    let escrow1 = obSrv.getEscrowAccountAddress(uuid1);
    let escrow1Ata = obSrv.getEscrowAtaTokenAddress(escrow1, mint1);

    let extraData: ExtraData = {
        dstChainId: "1",
        dstAddress: "0x...",
        dstToken: "usdt",
        dstAmount: "100",
        requestor: "requestor",
        lpId: "lpId",
        userSign: "0x...",
        lpSign: "0x..."
    }

    let tx = await obSrv.transferOut(
        uuid1,
        lp.publicKey,
        new BN(amount),
        userLock,
        relayLock,
        new BN(agreementReachedTime + 1 * stepTimelock),
        new BN(agreementReachedTime + 7 * stepTimelock),
        extraData,
        user,
        userAtaTokenMint1Account.address,
        escrow1,
        escrow1Ata,
        mint1,
        TOKEN_PROGRAM_ID
    );
    let txHash = await obSrv.sendTransaction(tx, [payer, user]);
    console.log(`transfer out tx: ${txHash}`);

    // transfer In
    console.log(`========== transfer in ==========`);
    let uuid2 = obSrv.getRandomBytes(16);

    let lpLock: Lock = {
        hash: userHashLock,
        deadline: new BN(agreementReachedTime + 5 * stepTimelock)
    };

    let escrow2 = obSrv.getEscrowAccountAddress(uuid2);
    let escrow2Ata = obSrv.getEscrowAtaTokenAddress(escrow2, mint2);

    tx = await obSrv.transferIn(
        uuid2,
        user.publicKey,
        new BN(amountBack),
        lpLock,
        new BN(agreementReachedTime + 2 * stepTimelock),
        new BN(agreementReachedTime + 7 * stepTimelock),
        lp,
        lpAtaTokenMint2Account.address,
        escrow2,
        escrow2Ata,
        mint2,
        TOKEN_PROGRAM_ID
    );
    txHash = await obSrv.sendTransaction(tx, [payer, lp]);
    console.log(`transfer in tx: ${txHash}`);

    // refund transfer out
    console.log(`wait until the agreement reached time + 7 * stepTimelock: ${agreementReachedTime + 7 * stepTimelock}`);
    while (true) {
        let curTimestamp = await obSrv.getCurOnChainTimestamp();
        if (!curTimestamp) {
            throw new Error("currentTime is null");
        }
        console.log(`currentTime: ${curTimestamp}`);
        if (curTimestamp > agreementReachedTime + 7 * stepTimelock) {
            break;
        }
        await sleep(1000);
    }

    console.log(`========== refund transfer out ==========`);
    tx = await obSrv.refundTransferOut(
        uuid1,
        userAtaTokenMint1Account.address,
        escrow1,
        escrow1Ata,
        TOKEN_PROGRAM_ID
    );
    txHash = await obSrv.sendTransaction(tx, [payer]);
    console.log(`refund transfer out tx: ${txHash}`);

    // refund transfer in
    console.log(`========== refund transfer in ==========`);
    tx = await obSrv.refundTransferIn(
        uuid2,
        lpAtaTokenMint2Account.address,
        escrow2,
        escrow2Ata,
        TOKEN_PROGRAM_ID
    );
    txHash = await obSrv.sendTransaction(tx, [payer]);
    console.log(`refund transfer in tx: ${txHash}`);
}

main();