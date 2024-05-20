import { SolanaJSONRPCError } from "@solana/web3.js";
import { BorshInstructionCoder } from "@coral-xyz/anchor";
import { ObridgeService } from "./ObridgeService";

export default class Monitor {
    obSrv: ObridgeService;
    lastSlot: number = 0;
    coder: BorshInstructionCoder;

    constructor(obSrv: ObridgeService) {
        this.obSrv = obSrv;
        this.coder = new BorshInstructionCoder(obSrv.program.idl);
    }

    async init() {
        this.lastSlot = await this.obSrv.connection.getSlot();
    }

    async start() {
        try {
            let block = await this.obSrv.connection.getBlock(this.lastSlot, {
                // maxSupportedTransactionVersion: 1,
                rewards: false,
                transactionDetails: "full",
            });

            if (block) {
                // console.log(this.lastSlot);
                for (let tx of block.transactions) {
                    // console.log(tx.transaction.message.accountKeys);
                    const isRelatedToProgram = tx.transaction.message.accountKeys.some((key) => key.toBase58() === this.obSrv.obridgeProgramId.toBase58());
                    if (isRelatedToProgram) {
                        // console.log(JSON.stringify(tx));
                        for (let ix of tx.transaction.message.instructions) {
                            if (tx.transaction.message.accountKeys[ix.programIdIndex].toBase58() === this.obSrv.obridgeProgramId.toBase58()) {
                                // console.log(ix.data);
                                let decodedData = this.coder.decode(ix.data, "base58");
                                console.log(decodedData);
                                if (decodedData) {
                                    let extraData = (decodedData.data as any).extraData;
                                    if (extraData && extraData.length > 0) {
                                        console.log(this.obSrv.decodeExtraData(extraData));
                                    }
                                }
                            }
                        }
                    }
                }
            }

            this.lastSlot++;

            setTimeout(() => {
                this.start();
            }, 200);

        } catch (err) {
            if ((err as SolanaJSONRPCError).message === `failed to get confirmed block: Block not available for slot ${this.lastSlot}`) {
                setTimeout(() => {
                    this.start();
                }, 200);
            } else {
                console.error(err);
            }
        }
    }
}