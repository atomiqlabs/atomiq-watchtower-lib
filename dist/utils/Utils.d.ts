export declare function getLogger(prefix: string): {
    debug: (msg: any, ...args: any[]) => void;
    info: (msg: any, ...args: any[]) => void;
    warn: (msg: any, ...args: any[]) => void;
    error: (msg: any, ...args: any[]) => void;
};
