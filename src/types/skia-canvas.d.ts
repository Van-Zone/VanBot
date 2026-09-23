// skia-canvas 为按需动态加载的可选依赖（缺失时插件自动降级为纯文本）。
// 这里只提供最小类型占位，保证未安装时类型检查通过；运行时以真实包为准。
declare module "skia-canvas" {
    export type FontFamily = string;
    export type FontWeight = string | number;
    export type CanvasRenderingContext2D = any;

    export class Image {
        constructor(width?: number, height?: number);
        src: string | Buffer;
        width: number;
        height: number;
        static load(src: string | Buffer): Promise<Image>;
    }

    export class Canvas {
        constructor(width?: number, height?: number);
        width: number;
        height: number;
        getContext(type: string): CanvasRenderingContext2D;
        toBuffer(format?: string): Promise<Buffer>;
        toBufferSync(format?: string): Buffer;
    }

    export function createCanvas(width: number, height: number): Canvas;

    export class FontLibrary {
        static use(...args: any[]): any;
        static familyNames(): string[];
        static reset(): void;
    }

    const _default: {
        createCanvas: typeof createCanvas;
        FontLibrary: typeof FontLibrary;
        Image: typeof Image;
        Canvas: typeof Canvas;
    };
    export default _default;
}
