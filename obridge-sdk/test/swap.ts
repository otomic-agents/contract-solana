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
    getOrCreateAssociatedTokenAccount,
    TOKEN_PROGRAM_ID
} from "@solana/spl-token";
import { ObridgeService, Lock } from "../src/ObridgeService";
import {
    airdropSOL,
    createAccountOnChain,
    createSPLTokenAndMintToUser,
} from "./utils";

async function main() {
    const connection = new Connection("http://127.0.0.1:8899", "confirmed");
    const obridgeProgramId = new PublicKey("2Xii6vHBc47isGv7ecXXdzcJbsPbH5rbHTsYuvycByRu");
    const payer = Keypair.generate();
    await airdropSOL(connection, payer.publicKey, 10 * 10 ** 9);
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
    let stepTimelock = 1;


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

    let txHash = await obSrv.transferOut(
        uuid1,
        lp.publicKey,
        new BN(amount),
        userLock,
        relayLock,
        new BN(agreementReachedTime + 1 * stepTimelock),
        new BN(agreementReachedTime + 7 * stepTimelock),
        Buffer.from([1,2,3,4,5,6,7,8,9,0]),
        user,
        userAtaTokenMint1Account.address,
        escrow1,
        escrow1Ata,
        mint1,
        TOKEN_PROGRAM_ID
    );
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

    txHash = await obSrv.transferIn(
        uuid2,
        user.publicKey,
        new BN(amountBack),
        lpLock,
        new BN(agreementReachedTime + 2 * stepTimelock),
        new BN(agreementReachedTime + 7 * stepTimelock),
        Buffer.from([1,2,3,4,5,6,7,8,9,0]),
        lp,
        lpAtaTokenMint2Account.address,
        escrow2,
        escrow2Ata,
        mint2,
        TOKEN_PROGRAM_ID
    );
    console.log(`transfer in tx: ${txHash}`);

    // confirm transfer out
    console.log(`========== confirm transfer out ==========`);
    let lpAtaTokenMint1Account = await getOrCreateAssociatedTokenAccount(connection, payer, mint1, lp.publicKey);
    txHash = await obSrv.confirmTransferOut(
        uuid1,
        userLockPreimage,
        lpAtaTokenMint1Account.address,
        escrow1,
        escrow1Ata,
        TOKEN_PROGRAM_ID
    );
    console.log(`confirm transfer out tx: ${txHash}`);

    // confirm transfer in
    console.log(`========== confirm transfer in ==========`);
    let userAtaTokenMint2Account = await getOrCreateAssociatedTokenAccount(connection, payer, mint2, user.publicKey);
    txHash = await obSrv.confirmTransferIn(
        uuid2,
        userLockPreimage,
        userAtaTokenMint2Account.address,
        escrow2,
        escrow2Ata,
        TOKEN_PROGRAM_ID
    );
    console.log(`confirm transfer out tx: ${txHash}`);
}

main();