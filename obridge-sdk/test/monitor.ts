import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { ObridgeService } from '../src/ObridgeService';

import 'dotenv/config';

async function main() {
    const connection = new Connection('https://api.devnet.solana.com', 'finalized');
    const obridgeProgramId = new PublicKey('2Xii6vHBc47isGv7ecXXdzcJbsPbH5rbHTsYuvycByRu');
    const payerPrivateKey = process.env.PAYER_PRIVATE_KEY;
    if (!payerPrivateKey) {
        console.error('PAYER_PRIVATE_KEY is not set');
        return;
    }
    const payer = Keypair.fromSecretKey(Uint8Array.from(payerPrivateKey.split(',').map((s) => parseInt(s))));
    const obSrv = new ObridgeService(connection, payer, obridgeProgramId, true);
}

main();
