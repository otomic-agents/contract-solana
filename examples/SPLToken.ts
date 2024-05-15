import { web3 } from "@coral-xyz/anchor";
import {
    createMint,
    getMint,
    TokenError,
    getOrCreateAssociatedTokenAccount,
    getAccount,
    mintTo,
    TOKEN_PROGRAM_ID,
    AccountLayout,
    transfer,
} from "@solana/spl-token";
import dotenv from "dotenv";

import { printConsoleSeparator, explorerURL, sleep } from "./utils";

dotenv.config();

async function initConnectionAndPayer() {
    const connection = new web3.Connection(web3.clusterApiUrl("devnet"), "confirmed");
    const secret = JSON.parse(process.env.PRIVATE_KEY ?? "") as number[];
    const secretKey = Uint8Array.from(secret);
    const payer = web3.Keypair.fromSecretKey(secretKey);

    // current balance
    const balance = await connection.getBalance(payer.publicKey);
    const balanceInSol = balance / web3.LAMPORTS_PER_SOL;
    console.log(`connected payer address: ${payer.publicKey} - balance ${balanceInSol} SOL`);

    return {
        connection: connection,
        payer: payer
    }
}

/*
    set payer as Mint's mintAuthority and freezeAuthority
*/
async function CreateMintProgram(connection: web3.Connection, payer: web3.Keypair) {
    const mint = await createMint(
        connection,
        payer,
        payer.publicKey,
        payer.publicKey,
        9 // We are using 9 to match the CLI decimal default exactly
    );

    const url = explorerURL({
        address: mint.toBase58()
    })
    console.log(`created a MINT successful, check it out: ${url}`);

    console.log("check MINT details ... ")
    while (true) {
        try {
            const mintInfo = await getMint(
                connection,
                mint
            )
            console.log(mintInfo);
            break;
        } catch (err) {
            if ((err as TokenError).name === "TokenAccountNotFoundError") {
                console.log(`get error: TokenAccountNotFoundError, wait for 5 seconds and check again`);
                await sleep(1000 * 5);
            } else {
                throw err;
            }
        }
    }
    return mint;
}

/*
    set payer as the generated ata token account's owner 
*/
async function getATAAccountAndMintTo(connection: web3.Connection, mint: web3.PublicKey, mintAmount: number, payer: web3.Keypair) {
    let ataTokenAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        mint,
        payer.publicKey
    );
    console.log(`created a ataTokenAccount ${ataTokenAccount.address} owned by ${payer.publicKey} for token ${mint}`);

    ataTokenAccount = await getAccount(
        connection,
        ataTokenAccount.address
    );
    console.log(`before mintTo, ata account ${ataTokenAccount.address} balance: ${ataTokenAccount.amount}`);

    await mintTo(
        connection,
        payer,
        mint,
        ataTokenAccount.address,
        payer.publicKey,
        mintAmount // because decimals for the mint are set to 9 
    );

    ataTokenAccount = await getAccount(
        connection,
        ataTokenAccount.address
    );
    console.log(`after mintTo, ata account ${ataTokenAccount.address} balance: ${ataTokenAccount.amount}`);

    return ataTokenAccount;
}

async function checkAllTokensByOwner(connection: web3.Connection, owner: web3.PublicKey) {
    const tokenAccounts = await connection.getTokenAccountsByOwner(
        owner,
        {
            programId: TOKEN_PROGRAM_ID,
        }
    );

    console.log(`Owned token by ${owner}`);
    console.log("Token                                         Balance");
    console.log("------------------------------------------------------------");
    tokenAccounts.value.forEach((tokenAccount) => {
        const accountData = AccountLayout.decode(tokenAccount.account.data);
        console.log(`${accountData.mint}   ${accountData.amount}`);
    })
}

/*
    payer will be the sender
*/
async function transferSPLToken(connection: web3.Connection, mint: web3.PublicKey, to: web3.PublicKey, amount: number, payer: web3.Keypair) {
    let fromAtaTokenAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        mint,
        payer.publicKey
    );

    let toAtaTokenAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        mint,
        to
    );

    let fromAcount = await  getAccount(
        connection,
        fromAtaTokenAccount.address
    );
    console.log(`before transfer, from account ${fromAcount.address} balance: ${fromAcount.amount}`);
    let toAcount = await  getAccount(
        connection,
        toAtaTokenAccount.address
    );
    console.log(`before transfer, to account ${toAcount.address} balance: ${toAcount.amount}`);

    await transfer(
        connection, 
        payer,
        fromAtaTokenAccount.address,
        toAtaTokenAccount.address,
        payer,
        amount
    );

    fromAcount = await  getAccount(
        connection,
        fromAtaTokenAccount.address
    );
    console.log(`after transfer, from account ${fromAcount.address} balance: ${fromAcount.amount}`);
    toAcount = await  getAccount(
        connection,
        toAtaTokenAccount.address
    );
    console.log(`after transfer, to account ${toAcount.address} balance: ${toAcount.amount}`);
}

async function main() {
    const { connection, payer } = await initConnectionAndPayer();
    const MINT = await CreateMintProgram(connection, payer);
    await getATAAccountAndMintTo(connection, MINT, 1_000_000_000, payer);
    await checkAllTokensByOwner(connection, payer.publicKey);

    let toWallet = web3.Keypair.generate();
    await transferSPLToken(connection, MINT, toWallet.publicKey, 50, payer);
}

main();
