import crypto from "crypto";
import * as anchor from "@coral-xyz/anchor";
import { Program, web3 } from "@coral-xyz/anchor";
import { Obridge } from "../target/types/obridge";
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
  ASSOCIATED_TOKEN_PROGRAM_ID
} from "@solana/spl-token";
import { keccak_256 } from "@noble/hashes/sha3";
import BN from "bn.js";

type Lock = {
  hash: Array<number>
  deadline: BN
}

describe("obridge", async () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);


  it("SPL A_Token -> SPL B_Token", async () => {

    const connection = provider.connection;
    console.log(`network connected: ${connection.rpcEndpoint}`);
    const program = anchor.workspace.Obridge as Program<Obridge>;
    console.log(`obridge program: ${program.programId}`);

    const user = web3.Keypair.generate();
    console.log(`user: ${user.publicKey}`);

    let userBal = await connection.getBalance(user.publicKey);
    // airdrop if less than 10 SOL
    if (userBal < 10 * web3.LAMPORTS_PER_SOL) {
      let tx = await connection.requestAirdrop(user.publicKey, 10 * web3.LAMPORTS_PER_SOL);
      await connection.confirmTransaction(tx);
    }
    userBal = await connection.getBalance(user.publicKey);
    console.log(`user balance: ${userBal / web3.LAMPORTS_PER_SOL} SOL`);


    // create SLP Token Mint1
    const mint1 = await createMint(
      connection,
      user,
      user.publicKey,
      user.publicKey,
      9 // We are using 9 to match the CLI decimal default exactly
    );
    console.log(`created SLP token mint1 ${mint1}`)

    // create user ata account for token mint1
    let userAtaTokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      user,
      mint1,
      user.publicKey
    );
    console.log(`created ata address ${userAtaTokenAccount.address} of user ${user.publicKey} SLP token mint1 ${mint1}`)

    // mint 1000 mint1 token to user
    let amount = 1000;
    await mintTo(
      connection,
      user,
      mint1,
      userAtaTokenAccount.address,
      user.publicKey,
      amount
    );

    userAtaTokenAccount = await getAccount(
      connection,
      userAtaTokenAccount.address
    );
    console.log(`token mint1 ${mint1} user ata account ${userAtaTokenAccount.address} balance: ${userAtaTokenAccount.amount}`);

    const lp = web3.Keypair.generate();
    console.log(`lp: ${lp.publicKey}`);

    let _uuid = new Uint8Array(16);
    let uuid = Array.from(crypto.getRandomValues(_uuid));
    console.log(`generate a random uuid: ${uuid}`);

    let _preimage = new Uint8Array(32);
    let preimage = Array.from(crypto.getRandomValues(_preimage));
    console.log(`generate a random preimage: ${preimage}`);

    let _relayPreimage = new Uint8Array(32);
    let relayPreimage = Array.from(crypto.getRandomValues(_relayPreimage));
    console.log(`generate a random relayPreimage: ${relayPreimage}`);

    let slot = await connection.getSlot();
    let agreementReachedTime = await connection.getBlockTime(slot);
    console.log(`agreementReachedTime: ${agreementReachedTime}`);
    let stepTimelock = 60

    let hashlock = Array.from(keccak_256(Buffer.from(preimage)));
    console.log(`generate hashlock: ${hashlock}`);
    let relayHashlock = Array.from(keccak_256(Buffer.from(relayPreimage)));
    console.log(`generate relayHashlock: ${relayHashlock}`);

    let lock1: Lock = {
      hash: hashlock,
      deadline: new BN(agreementReachedTime + 3 * stepTimelock)
    }
    let lock2: Lock = {
      hash: relayHashlock,
      deadline: new BN(agreementReachedTime + 6 * stepTimelock)
    }

    // create Pda account with seed <uuid>
    let [escrow,] = web3.PublicKey.findProgramAddressSync([Buffer.from(uuid)], program.programId);
    console.log(`escrow: ${escrow}`);
    // create escrow ata account for token mint1
    let escrowAtaTokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      user,
      mint1,
      escrow
    );
    console.log(`created ata address ${escrowAtaTokenAccount.address} of user ${escrow} SLP token mint1 ${mint1}`)

    const tx = await program.methods
      .initiate(
        uuid,
        lp.publicKey,
        new BN(amount),
        lock1,
        lock2
      )
      .accounts({
        payer: user.publicKey,
        from: user.publicKey,
        mint: mint1,
        source: userAtaTokenAccount.address,
        escrow: escrow,
        escrowAta: escrowAtaTokenAccount.address,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID
      })
      .signers([user])
      .rpc();


    console.log(tx);

  })
});
