import {
    Connection,
    Keypair,
    PublicKey,
    SystemProgram,
    Transaction,
    sendAndConfirmTransaction
} from "@solana/web3.js";
import {
    createMint,
    getOrCreateAssociatedTokenAccount,
    mintTo,
} from "@solana/spl-token";

export async function airdropSOL(connection: Connection, address: PublicKey, amountInLamports: number) {
    let accountBal = await connection.getBalance(address);
    if (accountBal < amountInLamports) {
        let tx = await connection.requestAirdrop(address, amountInLamports);
        await connection.confirmTransaction(tx);
    }
}

export async function createAccountOnChain(connection: Connection, payer: Keypair): Promise<Keypair> {
    // amount of space to reserve for the account
    const space = 0;

    // Seed the created account with lamports for rent exemption
    const rentExemptionAmount = await connection.getMinimumBalanceForRentExemption(space);

    const newAccountPubkey = Keypair.generate();
    const createAccountParams = {
        fromPubkey: payer.publicKey,
        newAccountPubkey: newAccountPubkey.publicKey,
        lamports: rentExemptionAmount,
        space,
        programId: SystemProgram.programId,
    };

    const createAccountTransaction = new Transaction().add(
        SystemProgram.createAccount(createAccountParams),
    );

    await sendAndConfirmTransaction(connection, createAccountTransaction, [
        payer,
        newAccountPubkey,
    ]);

    return newAccountPubkey;
}

export async function createSPLTokenAndMintToUser(connection: Connection, payer: Keypair, user: Keypair, amountInLamports: number) {

    // create SPL Token Mint
    const mint = await createMint(
        connection,
        payer,
        payer.publicKey,
        payer.publicKey,
        9 // token decimals
    );

    // create user ata account for token mint
    let ataTokenAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        mint,
        user.publicKey
    );

    // mint amount token to user
    await mintTo(
        connection,
        payer,
        mint,
        ataTokenAccount.address,
        payer.publicKey,
        amountInLamports
    );

    return {
        mint,
        ataTokenAccount
    };
}

export async function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}