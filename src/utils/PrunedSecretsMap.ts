
export class PrunedSecretsMap {
    maxSize: number;
    buffer: Array<string>;
    nextIndex: number;
    secretsMap: Map<string, string>;

    constructor(maxSize: number = 10000) {
        this.maxSize = maxSize;
        this.buffer = new Array(maxSize);
        this.nextIndex = 0;
        this.secretsMap = new Map();
    }

    set(escrowHash: string, secret: string) {
        const oldId = this.buffer[this.nextIndex];
        if (oldId !== undefined) {
            this.secretsMap.delete(oldId);
        }

        this.buffer[this.nextIndex] = escrowHash;
        this.secretsMap.set(escrowHash, secret);

        this.nextIndex = (this.nextIndex + 1) % this.maxSize;
    }

    get(escrowHash: string): string {
        return this.secretsMap.get(escrowHash);
    }
}