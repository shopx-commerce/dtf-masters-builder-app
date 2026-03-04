export interface SpotColorInput {
  hex: string;
  rgb: { r: number; g: number; b: number };
  spotWhite: boolean;
  spotGloss: boolean;
  spotWhiteName?: string;
  spotGlossName?: string;
  spotFluorY: boolean;
  spotFluorM: boolean;
  spotFluorG: boolean;
  spotFluorOrange: boolean;
  spotFluorYName?: string;
  spotFluorMName?: string;
  spotFluorGName?: string;
  spotFluorOrangeName?: string;
}
