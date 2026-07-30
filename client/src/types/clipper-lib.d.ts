declare module 'clipper-lib' {
  export interface IntPoint {
    X: number;
    Y: number;
  }

  export enum ClipType {
    ctIntersection = 0,
    ctUnion = 1,
    ctDifference = 2,
    ctXor = 3
  }

  export enum PolyType {
    ptSubject = 0,
    ptClip = 1
  }

  export enum PolyFillType {
    pftEvenOdd = 0,
    pftNonZero = 1,
    pftPositive = 2,
    pftNegative = 3
  }

  export enum JoinType {
    jtSquare = 0,
    jtRound = 1,
    jtMiter = 2
  }

  export enum EndType {
    etClosedPolygon = 0,
    etClosedLine = 1,
    etOpenButt = 2,
    etOpenSquare = 3,
    etOpenRound = 4
  }

  export class Clipper {
    constructor(initOptions?: number);
    AddPath(path: IntPoint[], polyType: PolyType, closed: boolean): boolean;
    AddPaths(paths: IntPoint[][], polyType: PolyType, closed: boolean): boolean;
    Execute(clipType: ClipType, solution: IntPoint[][], subjFillType?: PolyFillType, clipFillType?: PolyFillType): boolean;
    Clear(): void;
    static CleanPolygon(path: IntPoint[], distance?: number): IntPoint[];
    static CleanPolygons(paths: IntPoint[][], distance?: number): IntPoint[][];
    static SimplifyPolygon(path: IntPoint[], fillType?: PolyFillType): IntPoint[][];
    static SimplifyPolygons(paths: IntPoint[][], fillType?: PolyFillType): IntPoint[][];
    static Area(path: IntPoint[]): number;
    static Orientation(path: IntPoint[]): boolean;
  }

  export class ClipperOffset {
    constructor(miterLimit?: number, arcTolerance?: number);
    AddPath(path: IntPoint[], joinType: JoinType, endType: EndType): void;
    AddPaths(paths: IntPoint[][], joinType: JoinType, endType: EndType): void;
    Execute(solution: IntPoint[][], delta: number): void;
    Clear(): void;
    MiterLimit: number;
    ArcTolerance: number;
  }

  export function JS(paths: IntPoint[][]): void;
  
  const ClipperLib: {
    Clipper: typeof Clipper;
    ClipperOffset: typeof ClipperOffset;
    IntPoint: IntPoint;
    ClipType: typeof ClipType;
    PolyType: typeof PolyType;
    PolyFillType: typeof PolyFillType;
    JoinType: typeof JoinType;
    EndType: typeof EndType;
  };
  
  export default ClipperLib;
}
