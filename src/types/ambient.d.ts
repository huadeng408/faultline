declare module 'troika-three-text' {
  import * as THREE from 'three';
  export class Text extends THREE.Mesh {
    text: string;
    fontSize: number;
    color: number | string;
    font?: string;
    anchorX: number | 'left' | 'center' | 'right' | string;
    anchorY: number | 'top' | 'top-baseline' | 'middle' | 'bottom-baseline' | 'bottom' | string;
    maxWidth?: number;
    letterSpacing?: number;
    lineHeight?: number | string;
    textAlign?: 'left' | 'right' | 'center' | 'justify';
    fillOpacity?: number;
    outlineWidth?: number | string;
    outlineColor?: number | string;
    sync(callback?: () => void): void;
    dispose(): void;
  }
}

declare module 'alea' {
  export default function Alea(seed?: string | number): () => number;
}

declare module 'three.meshline' {
  import * as THREE from 'three';
  export class MeshLine extends THREE.BufferGeometry {
    geometry: THREE.BufferGeometry;
    setPoints(points: Float32Array | number[] | THREE.Vector3[], widthCallback?: (p: number) => number): void;
    setGeometry(g: THREE.BufferGeometry, widthCallback?: (p: number) => number): void;
  }
  export interface MeshLineMaterialParameters {
    color?: THREE.Color | number | string;
    lineWidth?: number;
    opacity?: number;
    transparent?: boolean;
    dashArray?: number;
    dashOffset?: number;
    dashRatio?: number;
    resolution?: THREE.Vector2;
    sizeAttenuation?: number | boolean;
    depthTest?: boolean;
    depthWrite?: boolean;
    blending?: THREE.Blending;
    alphaTest?: number;
  }
  export class MeshLineMaterial extends THREE.ShaderMaterial {
    constructor(parameters?: MeshLineMaterialParameters);
    lineWidth: number;
    color: THREE.Color;
    opacity: number;
    dashOffset: number;
    resolution: THREE.Vector2;
  }
  export function MeshLineRaycast(raycaster: THREE.Raycaster, intersects: THREE.Intersection[]): void;
}

declare module 'fastnoise-lite' {
  export default class FastNoiseLite {
    static NoiseType: {
      OpenSimplex2: string;
      OpenSimplex2S: string;
      Cellular: string;
      Perlin: string;
      ValueCubic: string;
      Value: string;
    };
    static FractalType: {
      None: string;
      FBm: string;
      Ridged: string;
      PingPong: string;
      DomainWarpProgressive: string;
      DomainWarpIndependent: string;
    };
    static CellularDistanceFunction: {
      Euclidean: string;
      EuclideanSq: string;
      Manhattan: string;
      Hybrid: string;
    };
    constructor(seed?: number);
    SetSeed(seed: number): void;
    SetFrequency(freq: number): void;
    SetNoiseType(type: string): void;
    SetFractalType(type: string): void;
    SetFractalOctaves(octaves: number): void;
    SetFractalLacunarity(lacunarity: number): void;
    SetFractalGain(gain: number): void;
    GetNoise(x: number, y: number, z?: number): number;
    DomainWarp(coord: { x: number; y: number; z?: number }): void;
  }
}

declare module 'd3-delaunay' {
  export class Voronoi<P> {
    cellPolygon(i: number): [number, number][] | null;
    render(): string;
    renderBounds(): string;
  }
  export class Delaunay<P> {
    static from<T>(
      points: ArrayLike<T> | Iterable<T>,
      fx?: (d: T, i: number) => number,
      fy?: (d: T, i: number) => number
    ): Delaunay<T>;
    constructor(points: ArrayLike<number>);
    find(x: number, y: number, i?: number): number;
    voronoi(bounds?: [number, number, number, number]): Voronoi<P>;
    render(): string;
  }
}

declare module 'curtainsjs' {
  export class Curtains {
    constructor(params: Record<string, unknown>);
    dispose(): void;
  }
  export class Plane {
    constructor(curtains: Curtains, element: HTMLElement, params?: Record<string, unknown>);
    uniforms: Record<string, { value: unknown }>;
    onRender(cb: () => void): this;
    remove(): void;
  }
}

declare module 'regl' {
  const createREGL: (opts?: Record<string, unknown>) => any;
  export default createREGL;
}

declare module 'twgl.js' {
  const twgl: Record<string, any>;
  export default twgl;
}
