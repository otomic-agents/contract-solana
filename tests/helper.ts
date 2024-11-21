import { web3 } from "@coral-xyz/anchor";
import {
    createMint,
    getOrCreateAssociatedTokenAccount,
    mintTo,
    TOKEN_PROGRAM_ID,
    AccountLayout,
    getMint,
} from "@solana/spl-token";
import BN from "bn.js";
import { keccak_256 } from "@noble/hashes/sha3";

export async function createAccountOnChain(connection: web3.Connection, payer: web3.Keypair): Promise<web3.Keypair> {
    // amount of space to reserve for the account
    const space = 0;

    // Seed the created account with lamports for rent exemption
    const rentExemptionAmount = await connection.getMinimumBalanceForRentExemption(space);

    const newAccountPubkey = web3.Keypair.generate();
    const createAccountParams = {
        fromPubkey: payer.publicKey,
        newAccountPubkey: newAccountPubkey.publicKey,
        lamports: rentExemptionAmount,
        space,
        programId: web3.SystemProgram.programId,
    };

    const createAccountTransaction = new web3.Transaction().add(web3.SystemProgram.createAccount(createAccountParams));

    await web3.sendAndConfirmTransaction(connection, createAccountTransaction, [payer, newAccountPubkey]);

    return newAccountPubkey;
}

export async function airdropSOL(connection: web3.Connection, account: web3.Keypair, amountInLamports: number) {
    let accountBal = await connection.getBalance(account.publicKey);
    if (accountBal < amountInLamports) {
        let tx = await connection.requestAirdrop(account.publicKey, amountInLamports);
        await connection.confirmTransaction(tx);
    }
}

export async function createSPLTokenAndMintToUser(
    connection: web3.Connection,
    payer: web3.Keypair,
    user: web3.Keypair,
    amountInLamports: number,
) {
    // create SPL Token Mint
    const mint = await createMint(
        connection,
        payer,
        payer.publicKey,
        payer.publicKey,
        9, // token decimals
    );

    // create user ata account for token mint
    let ataTokenAccount = await getOrCreateAssociatedTokenAccount(connection, payer, mint, user.publicKey);

    // mint amount token to user
    await mintTo(connection, payer, mint, ataTokenAccount.address, payer.publicKey, amountInLamports);

    return {
        mint,
        ataTokenAccount,
    };
}

export async function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function splTokensBalance(connection: web3.Connection, account: web3.PublicKey) {
    let tokenAccounts = await connection.getTokenAccountsByOwner(account, {
        programId: TOKEN_PROGRAM_ID,
    });
    console.log(`account ${account.toBase58()} spl balance:`);
    for (let tokenAccount of tokenAccounts.value) {
        const accountData = AccountLayout.decode(tokenAccount.account.data);
        let mintInfo = await getMint(connection, accountData.mint);
        console.log(
            `token program: ${TOKEN_PROGRAM_ID.toBase58()}, mint: ${accountData.mint.toBase58()}, decimals: ${
                mintInfo.decimals
            }, balance: ${accountData.amount}`,
        );
    }
}

export async function transferSOL(
    connection: web3.Connection,
    from: web3.Keypair,
    to: web3.PublicKey,
    amountInLamports: number,
) {
    let tx = new web3.Transaction().add(
        web3.SystemProgram.transfer({
            fromPubkey: from.publicKey,
            toPubkey: to,
            lamports: amountInLamports,
        }),
    );
    let confirm = await web3.sendAndConfirmTransaction(connection, tx, [from]);
    return confirm;
}

export function generateUuid(
    sender: web3.PublicKey,
    receiver: web3.PublicKey,
    hashlock: number[],
    agreementReachedTime: BN,
    expectedSingleStepTime: BN,
    tolerantSingleStepTime: BN,
    earliestRefundTime: BN,
    token: web3.PublicKey,
    tokenAmount: BN,
    ethAmount: BN,
): number[] {
    let data = Buffer.concat([
        sender.toBuffer(),
        receiver.toBuffer(),
        Buffer.from(hashlock),
        Buffer.from(agreementReachedTime.toArrayLike(Buffer, "le", 64)),
        Buffer.from(expectedSingleStepTime.toArrayLike(Buffer, "le", 16)),
        Buffer.from(tolerantSingleStepTime.toArrayLike(Buffer, "le", 16)),
        Buffer.from(earliestRefundTime.toArrayLike(Buffer, "le", 64)),
        token.toBuffer(),
        Buffer.from(tokenAmount.toArrayLike(Buffer, "le", 256)),
        Buffer.from(ethAmount.toArrayLike(Buffer, "le", 256)),
    ]);
    return Array.from(keccak_256(data));
}

export function generateUuidSol(
    sender: web3.PublicKey,
    receiver: web3.PublicKey,
    hashlock: number[],
    agreementReachedTime: BN,
    expectedSingleStepTime: BN,
    tolerantSingleStepTime: BN,
    earliestRefundTime: BN,
    solAmount: BN,
): number[] {
    let data = Buffer.concat([
        sender.toBuffer(),
        receiver.toBuffer(),
        Buffer.from(hashlock),
        Buffer.from(agreementReachedTime.toArrayLike(Buffer, "le", 64)),
        Buffer.from(expectedSingleStepTime.toArrayLike(Buffer, "le", 16)),
        Buffer.from(tolerantSingleStepTime.toArrayLike(Buffer, "le", 16)),
        Buffer.from(earliestRefundTime.toArrayLike(Buffer, "le", 64)),
        Buffer.from(solAmount.toArrayLike(Buffer, "le", 256)),
    ]);
    return Array.from(keccak_256(data));
}

export function generateUuidSwap(
    sender: web3.PublicKey,
    receiver: web3.PublicKey,
    srcToken: web3.PublicKey,
    srcTokenAmount: BN,
    destToken: web3.PublicKey,
    destTokenAmount: BN,
    agreementReachedTime: BN,
    stepTime: BN,
): number[] {
    let data = Buffer.concat([
        sender.toBuffer(),
        receiver.toBuffer(),
        srcToken.toBuffer(),
        Buffer.from(srcTokenAmount.toArrayLike(Buffer, "le", 64)),
        destToken.toBuffer(),
        Buffer.from(destTokenAmount.toArrayLike(Buffer, "le", 64)),
        Buffer.from(agreementReachedTime.toArrayLike(Buffer, "le", 64)),
        Buffer.from(stepTime.toArrayLike(Buffer, "le", 16)),
    ]);
    return Array.from(keccak_256(data));
}
