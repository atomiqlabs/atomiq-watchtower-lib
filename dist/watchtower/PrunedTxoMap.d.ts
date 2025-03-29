/// <reference types="node" />
import { BitcoinRpc, BtcBlock, BtcBlockWithTxs } from "@atomiqlabs/base";
export declare class PrunedTxoMap {
    readonly map: Map<string, {
        txId: string;
        vout: number;
        height: number;
    }>;
    readonly blocksMap: Map<number, {
        txoHashes: Buffer[];
        blockHash: string;
    }>;
    readonly filename: string;
    tipHeight: number;
    readonly bitcoinRpc: BitcoinRpc<any>;
    readonly pruningFactor: number;
    constructor(filename: string, bitcoinRpc: BitcoinRpc<BtcBlock>, pruningFactor?: number);
    init(btcRelayHeight: number): Promise<number>;
    syncToTipHash(tipBlockHash: string, waitingForTxosMap?: Map<string, any>): Promise<Map<string, {
        txId: string;
        vout: number;
        height: number;
    }>>;
    static toTxoHash(value: number, outputScript: string): Buffer;
    addBlock(headerHash: string, waitingForTxosMap?: Map<string, any>, noSaveTipHeight?: boolean): Promise<{
        block: BtcBlockWithTxs;
        foundTxos: Map<string, {
            txId: string;
            vout: number;
            height: number;
        }>;
    }>;
    getTxoObject(txoHash: string): {
        txId: string;
        vout: number;
        height: number;
    };
}
