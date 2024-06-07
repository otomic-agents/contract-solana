import { SolanaJSONRPCError, Message } from '@solana/web3.js';
import { BorshInstructionCoder } from '@coral-xyz/anchor';
import { ObridgeService } from './ObridgeService';

export async function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

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
        await sleep(400);
    }

    async start() {
        try {
            let block = await this.obSrv.connection.getBlock(this.lastSlot, {
                maxSupportedTransactionVersion: 0,
                rewards: false,
                transactionDetails: 'full',
            });
            console.log(`block: ${this.lastSlot}`);

            if (block) {
                for (let tx of block.transactions) {
                    if (tx.version === 'legacy' && !tx.meta?.err) {
                        let message = tx.transaction.message as Message;
                        const isRelatedToProgram = message.accountKeys.some(
                            (key) => key.toBase58() === this.obSrv.obridgeProgramId.toBase58(),
                        );
                        if (isRelatedToProgram) {
                            for (let ix of message.instructions) {
                                if (
                                    message.accountKeys[ix.programIdIndex].toBase58() ===
                                    this.obSrv.obridgeProgramId.toBase58()
                                ) {
                                    let decodedData = this.coder.decode(ix.data, 'base58');
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
            }

            this.lastSlot++;

            setTimeout(() => {
                this.start();
            }, 400);
        } catch (err) {
            if (
                (err as SolanaJSONRPCError).message ===
                `failed to get confirmed block: Block not available for slot ${this.lastSlot}`
            ) {
                setTimeout(() => {
                    this.start();
                }, 400);
            } else {
                console.error(err);
            }
        }
    }
}
