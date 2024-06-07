// Migrations are an early feature. Currently, they're nothing more than this
// single deploy script that's invoked from the CLI, injecting a provider
// configured from the workspace's Anchor.toml.

import * as anchor from '@coral-xyz/anchor';
import { Program, web3 } from '@coral-xyz/anchor';
import { Obridge } from '../target/types/obridge';
import * as dotenv from 'dotenv';

dotenv.config();

async function main() {
    let provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const wallet = provider.wallet;
    console.log(`wallet public key: ${wallet.publicKey.toBase58()}`);

    const obridge = anchor.workspace.Obridge as Program<Obridge>;
    console.log(`obridge program id: ${obridge.programId.toBase58()}`);

    let [adminSettingsPubKey] = web3.PublicKey.findProgramAddressSync([Buffer.from('settings')], obridge.programId);
    let tx = await obridge.methods
        .initialize(wallet.publicKey)
        .accounts({
            payer: wallet.publicKey,
            adminSettings: adminSettingsPubKey,
            systemProgram: web3.SystemProgram.programId,
        })
        .rpc();

    console.log(`successfully initialized program with tx: ${tx}`);
    console.log('Program deployed successfully');
}

main();
