import {createHash} from "crypto";
import * as fs from "fs/promises";
import {BitcoinRpc, BtcBlock, BtcBlockWithTxs} from "@atomiqlabs/base";


export class PrunedTxMap {

    readonly txoMap = new Map<string, {
        txId: string,
        vout: number,
        height: number
    }>();
    readonly txinMap = new Map<string, {
        txId: string,
        height: number
    }>();
    readonly blocksMap = new Map<number, {
        txoHashes: Buffer[],
        txins: string[],
        blockHash: string
    }>();

    readonly filename: string;
    tipHeight: number;

    readonly bitcoinRpc: BitcoinRpc<any>;

    readonly pruningFactor: number;

    constructor(filename: string, bitcoinRpc: BitcoinRpc<BtcBlock>, pruningFactor?: number) {
        this.filename = filename;
        this.bitcoinRpc = bitcoinRpc;
        this.pruningFactor = pruningFactor || 30;
    }

    async init(btcRelayHeight: number): Promise<number> {

        //Load last synced blockheight
        try {
            const result = await fs.readFile(this.filename);
            const height = parseInt(result.toString());
            btcRelayHeight = height;
        } catch (e) {}

        this.tipHeight = btcRelayHeight;

        //Build up the index for the last synced blockheight
        for(let i=0;i<this.pruningFactor;i++) {
            const blockHash = await this.bitcoinRpc.getBlockhash(btcRelayHeight-i);

            const {block} = await this.addBlock(blockHash, null, null, null, true);
        }

        return this.tipHeight;

    }

    async syncToTipHash(tipBlockHash: string, waitingForTxosMap?: Map<string, any>, waitingForTxinMap?: Map<string, any>): Promise<{
        foundTxos: Map<string, {
            txId: string,
            vout: number,
            height: number
        }>,
        foundTxins: Map<string, {
            txId: string,
            height: number
        }>
    }> {
        console.log("[PrunedTxoMap]: Syncing to tip hash: ", tipBlockHash);

        const blockHashes = [tipBlockHash];
        while(true) {
            const btcBlockHeader = await this.bitcoinRpc.getBlockHeader(blockHashes[blockHashes.length-1]);
            const previousHeight = btcBlockHeader.getHeight()-1;
            const previousHash = btcBlockHeader.getPrevBlockhash();
            const data = this.blocksMap.get(previousHeight);

            //Correct block already in cache
            if(data!=null) {
                if(data.blockHash===previousHash) break;
            }

            //Will replace all the existing cache anyway
            const minBlockHeight = this.tipHeight-this.pruningFactor;
            if(btcBlockHeader.getHeight()<minBlockHeight) {
                break;
            }

            blockHashes.push(previousHash);
        }

        const totalFoundTxos = new Map<string, {
            txId: string,
            vout: number,
            height: number
        }>();
        const totalFoundTxins = new Map<string, {
            txId: string,
            height: number
        }>();

        console.log("[PrunedTxoMap]: Syncing through blockhashes: ", blockHashes);

        const newlyCreatedUtxos = new Set<string>();
        for(let i=blockHashes.length-1;i>=0;i--) {
            const {foundTxos, foundTxins} = await this.addBlock(blockHashes[i], waitingForTxosMap, waitingForTxinMap, newlyCreatedUtxos);
            foundTxos.forEach((value, key: string) => {
                totalFoundTxos.set(key, value);
            })
            foundTxins.forEach((value, key: string) => {
                totalFoundTxins.set(key, value);
            });
        }

        return {
            foundTxos: totalFoundTxos,
            foundTxins: totalFoundTxins
        };
    }

    static toTxoHash(value: number, outputScript: string): Buffer {
        const buff = Buffer.alloc((outputScript.length/2) + 8);
        buff.writeBigUInt64LE(BigInt(value));
        buff.write(outputScript, 8, "hex");
        return createHash("sha256").update(buff).digest();
    }

    async addBlock(
        headerHash: string,
        waitingForTxosMap?: Map<string, any>,
        waitingForTxinMap?: Map<string, any>,
        newlyCreatedUtxos?: Set<string>,
        noSaveTipHeight?: boolean
    ): Promise<{
        block: BtcBlockWithTxs,
        foundTxos: Map<string, {
            txId: string,
            vout: number,
            height: number
        }>,
        foundTxins: Map<string, {
            txId: string,
            height: number
        }>
    }> {
        newlyCreatedUtxos ??= new Set();

        const block: BtcBlockWithTxs = await this.bitcoinRpc.getBlockWithTransactions(headerHash);

        console.log("[PrunedTxoMap]: Adding block  "+block.height+", hash: ", block.hash);
        if(!noSaveTipHeight) {
            this.tipHeight = block.height;
            await fs.writeFile(this.filename, this.tipHeight.toString());
        }

        const foundTxos = new Map<string, {
            txId: string,
            vout: number,
            height: number
        }>();
        const foundTxins = new Map<string, {
            txId: string,
            height: number
        }>();

        const blockTxoHashes: Buffer[] = [];
        const blockTxins: string[] = [];

        if(this.blocksMap.has(block.height)) {
            console.log("[PrunedTxoMap]: Fork block hash: ", block.hash);
            //Forked off
            for(let txoHash of this.blocksMap.get(block.height).txoHashes) {
                this.txoMap.delete(txoHash.toString("hex"));
            }
        }

        for(let tx of block.tx) {
            for(let vout of tx.outs) {
                const txoHash = PrunedTxMap.toTxoHash(vout.value, vout.scriptPubKey.hex);
                blockTxoHashes.push(txoHash);
                const txObj = {
                    txId: tx.txid,
                    vout: vout.n,
                    height: block.height
                };
                const txoHashHex = txoHash.toString("hex");
                this.txoMap.set(txoHashHex, txObj);
                if(waitingForTxosMap!=null && waitingForTxosMap.has(txoHashHex)) {
                    foundTxos.set(txoHashHex, txObj);
                }
            }
            for(let vin of tx.ins) {
                const spentUtxo = vin.txid+":"+vin.vout;
                blockTxins.push(spentUtxo);
                const txObj = {
                    txId: tx.txid,
                    height: block.height
                };
                this.txinMap.set(spentUtxo, txObj);
                if(waitingForTxinMap!=null && waitingForTxinMap.has(spentUtxo)) {
                    foundTxins.set(spentUtxo, txObj);
                    //We need to make sure we also check the newly created utxos here
                    newlyCreatedUtxos.add(tx.txid+":0");
                }
            }
        }

        for(let newlyCreatedUtxo of newlyCreatedUtxos.keys()) {
            let newUtxoData = this.txinMap.get(newlyCreatedUtxo);
            if(newUtxoData==null) continue;
            newlyCreatedUtxos.delete(newlyCreatedUtxo);
            while(newUtxoData!=null) {
                //Save it
                foundTxins.set(newlyCreatedUtxo, newUtxoData);
                //Check next one
                newlyCreatedUtxo = newUtxoData.txId+":0";
                newUtxoData = this.txinMap.get(newlyCreatedUtxo);
            }
        }

        this.blocksMap.set(block.height, {
            txoHashes: blockTxoHashes,
            txins: blockTxins,
            blockHash: block.hash
        });

        //Pruned
        const pruneBlockheight = block.height-this.pruningFactor;
        if(this.blocksMap.has(pruneBlockheight)) {
            console.log("[PrunedTxoMap]: Pruning block height: ", pruneBlockheight);
            const prunedBlock = this.blocksMap.get(pruneBlockheight);
            for(let txoHash of prunedBlock.txoHashes) {
                this.txoMap.delete(txoHash.toString("hex"));
            }
            for(let txin of prunedBlock.txins) {
                this.txinMap.delete(txin);
            }
            this.blocksMap.delete(pruneBlockheight);
        }

        return {
            block,
            foundTxos,
            foundTxins
        };
    }

    getTxoObject(txoHash: string): {
        txId: string,
        vout: number,
        height: number
    } {
        return this.txoMap.get(txoHash);
    }

    getTxinObject(utxo: string): {
        txId: string,
        height: number
    } {
        return this.txinMap.get(utxo);
    }

}
