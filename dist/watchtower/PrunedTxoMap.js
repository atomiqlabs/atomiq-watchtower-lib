"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrunedTxoMap = void 0;
const crypto_1 = require("crypto");
const fs = require("fs/promises");
class PrunedTxoMap {
    constructor(filename, bitcoinRpc, pruningFactor) {
        this.txoMap = new Map();
        this.txinMap = new Map();
        this.blocksMap = new Map();
        this.filename = filename;
        this.bitcoinRpc = bitcoinRpc;
        this.pruningFactor = pruningFactor || 30;
    }
    init(btcRelayHeight) {
        return __awaiter(this, void 0, void 0, function* () {
            //Load last synced blockheight
            try {
                const result = yield fs.readFile(this.filename);
                const height = parseInt(result.toString());
                btcRelayHeight = height;
            }
            catch (e) { }
            this.tipHeight = btcRelayHeight;
            //Build up the index for the last synced blockheight
            for (let i = 0; i < this.pruningFactor; i++) {
                const blockHash = yield this.bitcoinRpc.getBlockhash(btcRelayHeight - i);
                const { block } = yield this.addBlock(blockHash, null, null, true);
            }
            return this.tipHeight;
        });
    }
    syncToTipHash(tipBlockHash, waitingForTxosMap, waitingForTxinMap) {
        return __awaiter(this, void 0, void 0, function* () {
            console.log("[PrunedTxoMap]: Syncing to tip hash: ", tipBlockHash);
            const blockHashes = [tipBlockHash];
            while (true) {
                const btcBlockHeader = yield this.bitcoinRpc.getBlockHeader(blockHashes[blockHashes.length - 1]);
                const previousHeight = btcBlockHeader.getHeight() - 1;
                const previousHash = btcBlockHeader.getPrevBlockhash();
                const data = this.blocksMap.get(previousHeight);
                //Correct block already in cache
                if (data != null) {
                    if (data.blockHash === previousHash)
                        break;
                }
                //Will replace all the existing cache anyway
                const minBlockHeight = this.tipHeight - this.pruningFactor;
                if (btcBlockHeader.getHeight() < minBlockHeight) {
                    break;
                }
                blockHashes.push(previousHash);
            }
            const totalFoundTxos = new Map();
            const totalFoundTxins = new Map();
            console.log("[PrunedTxoMap]: Syncing through blockhashes: ", blockHashes);
            for (let i = blockHashes.length - 1; i >= 0; i--) {
                const { foundTxos, foundTxins } = yield this.addBlock(blockHashes[i], waitingForTxosMap, waitingForTxinMap);
                foundTxos.forEach((value, key) => {
                    totalFoundTxos.set(key, value);
                });
                foundTxins.forEach((value, key) => {
                    totalFoundTxins.set(key, value);
                });
            }
            return {
                foundTxos: totalFoundTxos,
                foundTxins: totalFoundTxins
            };
        });
    }
    static toTxoHash(value, outputScript) {
        const buff = Buffer.alloc((outputScript.length / 2) + 8);
        buff.writeBigUInt64LE(BigInt(value));
        buff.write(outputScript, 8, "hex");
        return (0, crypto_1.createHash)("sha256").update(buff).digest();
    }
    addBlock(headerHash, waitingForTxosMap, waitingForTxinMap, noSaveTipHeight) {
        return __awaiter(this, void 0, void 0, function* () {
            const block = yield this.bitcoinRpc.getBlockWithTransactions(headerHash);
            console.log("[PrunedTxoMap]: Adding block  " + block.height + ", hash: ", block.hash);
            if (!noSaveTipHeight) {
                this.tipHeight = block.height;
                yield fs.writeFile(this.filename, this.tipHeight.toString());
            }
            const foundTxos = new Map();
            const foundTxins = new Map();
            const blockTxoHashes = [];
            const blockTxins = [];
            if (this.blocksMap.has(block.height)) {
                console.log("[PrunedTxoMap]: Fork block hash: ", block.hash);
                //Forked off
                for (let txoHash of this.blocksMap.get(block.height).txoHashes) {
                    this.txoMap.delete(txoHash.toString("hex"));
                }
            }
            for (let tx of block.tx) {
                for (let vout of tx.outs) {
                    const txoHash = PrunedTxoMap.toTxoHash(vout.value, vout.scriptPubKey.hex);
                    blockTxoHashes.push(txoHash);
                    const txObj = {
                        txId: tx.txid,
                        vout: vout.n,
                        height: block.height
                    };
                    const txoHashHex = txoHash.toString("hex");
                    this.txoMap.set(txoHashHex, txObj);
                    if (waitingForTxosMap != null && waitingForTxosMap.has(txoHashHex)) {
                        foundTxos.set(txoHashHex, txObj);
                    }
                }
                for (let vin of tx.ins) {
                    const spentUtxo = vin.txid + ":" + vin.vout;
                    blockTxins.push(spentUtxo);
                    const txObj = {
                        txId: tx.txid,
                        height: block.height
                    };
                    this.txinMap.set(spentUtxo, txObj);
                    if (waitingForTxinMap != null && waitingForTxinMap.has(spentUtxo)) {
                        foundTxins.set(spentUtxo, txObj);
                    }
                }
            }
            this.blocksMap.set(block.height, {
                txoHashes: blockTxoHashes,
                txins: blockTxins,
                blockHash: block.hash
            });
            //Pruned
            const pruneBlockheight = block.height - this.pruningFactor;
            if (this.blocksMap.has(pruneBlockheight)) {
                console.log("[PrunedTxoMap]: Pruning block height: ", pruneBlockheight);
                const prunedBlock = this.blocksMap.get(pruneBlockheight);
                for (let txoHash of prunedBlock.txoHashes) {
                    this.txoMap.delete(txoHash.toString("hex"));
                }
                for (let txin of prunedBlock.txins) {
                    this.txinMap.delete(txin);
                }
                this.blocksMap.delete(pruneBlockheight);
            }
            return {
                block,
                foundTxos,
                foundTxins
            };
        });
    }
    getTxoObject(txoHash) {
        return this.txoMap.get(txoHash);
    }
    getTxinObject(utxo) {
        return this.txinMap.get(utxo);
    }
}
exports.PrunedTxoMap = PrunedTxoMap;
