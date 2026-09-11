declare module 'ndarray' {
  export type NdArray = {
    data: Float32Array;
    shape: number[];
    stride: number[];
    offset: number;
    order: number[];
    dimension: number;
    dtype: string;
  };
  export default function ndarray(data: Float32Array, shape: number[]): NdArray;
}

declare module 'surface-nets' {
  import type { NdArray } from 'ndarray';
  export default function surfaceNets(array: NdArray, level?: number): {
    positions: [number, number, number][];
    cells: [number, number, number][];
  };
}
