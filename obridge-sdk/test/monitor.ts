import {
    Connection,
    Keypair,
    PublicKey,
} from "@solana/web3.js";
import { ObridgeService } from "../src/ObridgeService";
import {
    airdropSOL,
} from "./utils";

async function main() {
    const connection = new Connection("http://127.0.0.1:8899", "confirmed");
    const obridgeProgramId = new PublicKey("2Xii6vHBc47isGv7ecXXdzcJbsPbH5rbHTsYuvycByRu");
    const payer = Keypair.generate();
    await airdropSOL(connection, payer.publicKey, 10 * 10 ** 9);
    const obSrv = new ObridgeService(connection, payer, obridgeProgramId, true);
}

main();