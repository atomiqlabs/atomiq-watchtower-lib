import {
    ChainSwapType,
    ChainType,
    Message,
    MessageType,
    Messenger,
    SwapClaimWitnessMessage,
    SwapData
} from "@atomiqlabs/base";
import {getLogger} from "../utils/Utils";
import {SavedSwap} from "./SavedSwap";


const logger = getLogger("HashlockWatchtower: ");

export class HashlockWatchtower<T extends ChainType> {

    readonly signer: T["Signer"];
    readonly swapContract: T["Contract"];
    readonly swapDataType: { new(): T["Data"] };
    readonly shouldClaimCbk?: (swap: SavedSwap<T>) => Promise<{initAta: boolean, feeRate: any}>;
    readonly messenger: Messenger;

    constructor(
        messenger: Messenger,
        swapContract: T["Contract"],
        swapDataType: { new(): T["Data"] },
        signer: T["Signer"],
        escrowShouldClaimCbk?: (swap: SavedSwap<T>) => Promise<{initAta: boolean, feeRate: any}>
    ) {
        this.swapContract = swapContract;
        this.signer = signer;
        this.swapDataType = swapDataType;
        this.signer = signer;
        this.messenger = messenger;
        this.shouldClaimCbk = escrowShouldClaimCbk;
    }

    async claim(swapData: T["Data"], witness: string): Promise<void> {
        const isCommitted = await this.swapContract.isCommited(swapData);
        if(!isCommitted) return;
        if(this.shouldClaimCbk!=null) {
            const feeData = await this.shouldClaimCbk(SavedSwap.fromSwapData(swapData));
            if(feeData==null) {
                logger.debug("claim(): Not claiming swap with escrowHash: "+swapData.getEscrowHash()+" due to negative response from shouldClaimCbk() callback!");
                return;
            }
            await this.swapContract.claimWithSecret(this.signer, swapData, witness, false, feeData.initAta, {feeRate: feeData.feeRate, waitForConfirmation: true});
        } else {
            await this.swapContract.claimWithSecret(this.signer, swapData, witness, false, undefined, {waitForConfirmation: true});
        }
        logger.info("claim(): Claimed successfully escrowHash: "+swapData.getEscrowHash()+" with witness: "+witness+"!");
    }

    readonly claimsInProcess: {[escrowHash: string]: Promise<void>};

    async init(): Promise<void> {
        await this.messenger.init();
        await this.messenger.subscribe((_msg: Message) => {
            if(_msg.type !== MessageType.SWAP_CLAIM_WITNESS) return;
            const msg = _msg as SwapClaimWitnessMessage<SwapData>;
            if(!(msg.swapData instanceof this.swapDataType)) return;
            if(msg.swapData.getType()!==ChainSwapType.HTLC) return;
            try {
                const parsedWitness = Buffer.from(msg.witness, "hex");
                if(parsedWitness.length!==32) return;
            } catch (e) {
                return;
            }
            const escrowHash = msg.swapData.getEscrowHash();
            if(this.claimsInProcess[escrowHash]!=null) {
                logger.debug("messageListener: Skipping escrowHash: "+escrowHash+" due to already being processed!");
                return;
            }
            this.claimsInProcess[escrowHash] = this.claim(msg.swapData as T["Data"], msg.witness).then(() => {
                delete this.claimsInProcess[escrowHash];
            }, (e) => {
                logger.error("messageListener: Error when claiming swap escrowHash: "+escrowHash);
                delete this.claimsInProcess[escrowHash];
            });
        });
        logger.info("init(): Initialized!");
    }

}
