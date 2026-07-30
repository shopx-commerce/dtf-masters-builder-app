declare module 'js-clipper' {
  namespace ClipperLib {
    interface IntPoint {
      X: number;
      Y: number;
    }
    
    type Path = IntPoint[];
    type Paths = Path[];
    
    enum ClipType {
      ctIntersection = 0,
      ctUnion = 1,
      ctDifference = 2,
      ctXor = 3
    }
    
    enum PolyType {
      ptSubject = 0,
      ptClip = 1
    }
    
    enum PolyFillType {
      pftEvenOdd = 0,
      pftNonZero = 1,
      pftPositive = 2,
      pftNegative = 3
    }
    
    enum JoinType {
      jtSquare = 0,
      jtRound = 1,
      jtMiter = 2
    }
    
    enum EndType {
      etClosedPolygon = 0,
      etClosedLine = 1,
      etOpenButt = 2,
      etOpenSquare = 3,
      etOpenRound = 4
    }
    
    class Clipper {
      constructor(initOptions?: number);
      AddPath(path: Path, polyType: PolyType, closed: boolean): boolean;
      AddPaths(paths: Paths, polyType: PolyType, closed: boolean): boolean;
      Execute(clipType: ClipType, solution: Paths, subjFillType?: PolyFillType, clipFillType?: PolyFillType): boolean;
      static Area(path: Path): number;
      static CleanPolygon(path: Path, distance?: number): Path;
      static CleanPolygons(paths: Paths, distance?: number): Paths;
      static SimplifyPolygon(path: Path, fillType?: PolyFillType): Paths;
      static SimplifyPolygons(paths: Paths, fillType?: PolyFillType): Paths;
    }
    
    class ClipperOffset {
      constructor(miterLimit?: number, arcTolerance?: number);
      ArcTolerance: number;
      MiterLimit: number;
      AddPath(path: Path, joinType: JoinType, endType: EndType): void;
      AddPaths(paths: Paths, joinType: JoinType, endType: EndType): void;
      Execute(solution: Paths, delta: number): void;
      Clear(): void;
    }
  }
  
  export = ClipperLib;
}
