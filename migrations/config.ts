import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { Program, Idl, AnchorProvider, setProvider, Wallet } from "@coral-xyz/anchor";
import * as idl from "../target/idl/obridge.json";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
    const connection = new Connection("https://api.devnet.solana.com", "confirmed");
    const obridgeProgramId = new PublicKey("FAqaHQHgBFFX8fJB6fQUqNdc8zABV5pGVRdCt7fLLYVo");

    const payerSecret = JSON.parse(process.env.PRIVATE_KEY) as number[];
    const payer = Keypair.fromSecretKey(Uint8Array.from(payerSecret));

    let wallet = new Wallet(payer);
    let provider = new AnchorProvider(connection, wallet, {});
    setProvider(provider);

    let obridge = new Program(idl as Idl, obridgeProgramId);

    const feeRecepientSecret = JSON.parse(process.env.FEE_RECEPIENT_PRIVATE_KEY) as number[];
    const feeRecepient = Keypair.fromSecretKey(Uint8Array.from(feeRecepientSecret));

    const adminSecret = JSON.parse(process.env.ADMIN_PRIVATE_KEY) as number[];
    const admin = Keypair.fromSecretKey(Uint8Array.from(adminSecret));

    console.log(`obridge program id: ${obridge.programId.toBase58()}`);

    let tx;

    // set admin
    let [adminSettingsPubKey] = PublicKey.findProgramAddressSync([Buffer.from("settings")], obridge.programId);
    tx = await obridge.methods
        .initialize(admin.publicKey)
        .accounts({
            payer: payer.publicKey,
            adminSettings: adminSettingsPubKey,
            systemProgram: SystemProgram.programId,
        })
        .rpc();

    console.log(`successfully initialized program with tx: ${tx}`);

    // set fee recepient
    tx = await obridge.methods
        .setFeeRecepient()
        .accounts({
            admin: admin.publicKey,
            feeRecepient: feeRecepient.publicKey,
            adminSettings: adminSettingsPubKey,
        })
        .signers([admin, feeRecepient])
        .rpc();

    console.log(`successfully set fee recepient tx: ${tx}`);

    // set fee rate to 10%
    tx = await obridge.methods
        .setFeeRate(1000)
        .accounts({
            admin: admin.publicKey,
            adminSettings: adminSettingsPubKey,
        })
        .signers([admin])
        .rpc();

    console.log(`set fee rate 10% tx: ${tx}`);

    console.log("Program config successfully");
}

main();
