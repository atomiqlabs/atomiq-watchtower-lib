/// <reference types="node" />
import { BitcoinRpc, BtcBlock, BtcBlockWithTxs } from "@atomiqlabs/base";
export declare class PrunedTxMap {
    readonly txoMap: Map<string, {
        txId: string;
        vout: number;
        height: number;
    }>;
    readonly txinMap: Map<string, {
        txId: string;
        height: number;
    }>;
    readonly blocksMap: Map<number, {
        txoHashes: Buffer[];
        txins: string[];
        blockHash: string;
    }>;
    readonly filename: string;
    tipHeight: number;
    readonly bitcoinRpc: BitcoinRpc<any>;
    readonly pruningFactor: number;
    constructor(filename: string, bitcoinRpc: BitcoinRpc<BtcBlock>, pruningFactor?: number);
    init(btcRelayHeight: number): Promise<number>;
    syncToTipHash(tipBlockHash: string, waitingForTxosMap?: Map<string, any>, waitingForTxinMap?: Map<string, any>): Promise<{
        foundTxos: Map<string, {
            txId: string;
            vout: number;
            height: number;
        }>;
        foundTxins: Map<string, {
            txId: string;
            height: number;
        }>;
    }>;
    static toTxoHash(value: number, outputScript: string): Buffer;
    addBlock(headerHash: string, waitingForTxosMap?: Map<string, any>, waitingForTxinMap?: Map<string, any>, newlyCreatedUtxos?: Set<string>, noSaveTipHeight?: boolean): Promise<{
        block: BtcBlockWithTxs;
        foundTxos: Map<string, {
            txId: string;
            vout: number;
            height: number;
        }>;
        foundTxins: Map<string, {
            txId: string;
            height: number;
        }>;
    }>;
    getTxoObject(txoHash: string): {
        txId: string;
        vout: number;
        height: number;
    };
    getTxinObject(utxo: string): {
        txId: string;
        height: number;
    };
}
