import { PDFDocument, PDFName, PDFArray, PDFDict, PDFPage, PDFHexString } from 'pdf-lib';
import { type SpotColorInput } from './spot-color-types';
import SpotColorWorker from './spot-color-worker?worker';

interface Point {
  x: number;
  y: number;
}

interface SpotColorRegion {
  name: string;
  paths: Point[][];
  tintCMYK: [number, number, number, number];
}

const SPOT_COLOR_DPI = 300;

function traceColorRegionsAsync(
  image: HTMLImageElement,
  spotColors: SpotColorInput[],
  widthInches: number,
  heightInches: number
): Promise<SpotColorRegion[]> {
  return new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(widthInches * SPOT_COLOR_DPI);
    canvas.height = Math.round(heightInches * SPOT_COLOR_DPI);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    const workerColors = spotColors.map(c => ({
      hex: c.hex,
      rgb: c.rgb,
      spotWhite: c.spotWhite,
      spotGloss: c.spotGloss,
      spotWhiteName: c.spotWhiteName,
      spotGlossName: c.spotGlossName,
      spotFluorY: c.spotFluorY,
      spotFluorM: c.spotFluorM,
      spotFluorG: c.spotFluorG,
      spotFluorOrange: c.spotFluorOrange,
      spotFluorYName: c.spotFluorYName,
      spotFluorMName: c.spotFluorMName,
      spotFluorGName: c.spotFluorGName,
      spotFluorOrangeName: c.spotFluorOrangeName,
    }));

    let worker: Worker;
    try {
      worker = new SpotColorWorker();
    } catch (err) {
      console.warn('[SpotColor] Worker creation failed, skipping spot colors:', err);
      resolve([]);
      return;
    }

    const pixelCount = canvas.width * canvas.height;
    const timeoutMs = Math.max(30000, Math.round(pixelCount / 50000) * 1000);

    const timeout = setTimeout(() => {
      worker.terminate();
      console.warn(`[SpotColor] Worker timed out after ${timeoutMs}ms`);
      resolve([]);
    }, timeoutMs);

    worker.onmessage = (e: MessageEvent) => {
      clearTimeout(timeout);
      worker.terminate();
      if (e.data.type === 'result') {
        const regions: SpotColorRegion[] = e.data.regions;
        console.log(`[SpotColor] Worker returned ${regions.length} regions at ${SPOT_COLOR_DPI} DPI`);
        for (const r of regions) {
          console.log(`[SpotColor]   ${r.name}: ${r.paths.length} contours`);
        }
        resolve(regions);
      } else {
        resolve([]);
      }
    };

    worker.onerror = (err) => {
      clearTimeout(timeout);
      worker.terminate();
      console.warn('[SpotColor] Worker error, skipping spot colors:', err);
      resolve([]);
    };

    console.log(`[SpotColor] Sending to worker: ${canvas.width}x${canvas.height} at ${SPOT_COLOR_DPI} DPI`);
    const buffer = imageData.data.buffer;
    worker.postMessage({
      type: 'trace',
      imageBuffer: buffer,
      imageWidth: canvas.width,
      imageHeight: canvas.height,
      spotColors: workerColors,
      widthInches,
      heightInches,
      dpi: SPOT_COLOR_DPI,
    }, [buffer]);
  });
}

function spotColorPathsToPDFOps(
  pathsInches: Point[][],
  spotColorName: string
): string {
  if (pathsInches.length === 0) return '';

  const validPaths = pathsInches.filter(p => p.length >= 3);
  if (validPaths.length === 0) return '';

  let compoundPath = 'q\n';
  compoundPath += `/${spotColorName} cs 1 scn\n`;

  for (const path of validPaths) {
    const pts = path.map(p => ({ x: p.x * 72, y: p.y * 72 }));
    compoundPath += `${pts[0].x.toFixed(4)} ${pts[0].y.toFixed(4)} m\n`;
    for (let j = 1; j < pts.length; j++) {
      compoundPath += `${pts[j].x.toFixed(4)} ${pts[j].y.toFixed(4)} l\n`;
    }
    compoundPath += 'h\n';
  }

  compoundPath += 'f*\n';
  compoundPath += 'Q\n';

  return compoundPath;
}

function appendContentStream(
  page: PDFPage,
  context: PDFDocument['context'],
  ops: string
): void {
  if (!ops || ops.length === 0) return;

  const contentStream = context.stream(ops);
  const contentStreamRef = context.register(contentStream);

  const existingContents = page.node.Contents();
  if (existingContents) {
    if (existingContents instanceof PDFArray) {
      existingContents.push(contentStreamRef);
    } else {
      const newContents = context.obj([existingContents, contentStreamRef]);
      page.node.set(PDFName.of('Contents'), newContents);
    }
  } else {
    page.node.set(PDFName.of('Contents'), contentStreamRef);
  }
}

function addSpotColorRegionAsLayer(
  pdfDoc: PDFDocument,
  page: PDFPage,
  region: SpotColorRegion,
  offsetPaths: Point[][],
  ocgRef: any
): void {
  const context = pdfDoc.context;

  const tintFunction = context.obj({
    FunctionType: 2,
    Domain: [0, 1],
    C0: [0, 0, 0, 0],
    C1: region.tintCMYK,
    N: 1,
  });
  const tintFunctionRef = context.register(tintFunction);

  const separationColorSpace = context.obj([
    PDFName.of('Separation'),
    PDFName.of(region.name),
    PDFName.of('DeviceCMYK'),
    tintFunctionRef,
  ]);
  const separationRef = context.register(separationColorSpace);

  let pageResources = page.node.Resources();
  if (!pageResources) {
    pageResources = context.obj({});
    page.node.set(PDFName.of('Resources'), pageResources);
  }

  let colorSpaceDict = pageResources.get(PDFName.of('ColorSpace'));
  if (!colorSpaceDict) {
    colorSpaceDict = context.obj({});
    (pageResources as PDFDict).set(PDFName.of('ColorSpace'), colorSpaceDict);
  }
  (colorSpaceDict as PDFDict).set(PDFName.of(region.name), separationRef);

  let propertiesDict = pageResources.get(PDFName.of('Properties'));
  if (!propertiesDict) {
    propertiesDict = context.obj({});
    (pageResources as PDFDict).set(PDFName.of('Properties'), propertiesDict);
  }
  const ocgTag = `OC_${region.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
  (propertiesDict as PDFDict).set(PDFName.of(ocgTag), ocgRef);

  const validPaths = offsetPaths.filter(p => p.length >= 3);
  if (validPaths.length === 0) return;

  let ops = `/OC /${ocgTag} BDC\nq\n`;
  ops += `/${region.name} cs 1 scn\n`;
  for (const path of validPaths) {
    const pts = path.map(p => ({ x: p.x * 72, y: p.y * 72 }));
    ops += `${pts[0].x.toFixed(4)} ${pts[0].y.toFixed(4)} m\n`;
    for (let j = 1; j < pts.length; j++) {
      ops += `${pts[j].x.toFixed(4)} ${pts[j].y.toFixed(4)} l\n`;
    }
    ops += 'h\n';
  }
  ops += 'f*\nQ\nEMC\n';

  console.log(`[SpotColor PDF] Layer "${region.name}": ${region.paths.length} contours, ${ops.length} chars`);
  appendContentStream(page, context, ops);
}

/**
 * Add spot color vectors to the same page as the raster image,
 * each fluorescent color in its own named OCG layer.
 */
export async function addSpotColorVectorsToPDF(
  pdfDoc: PDFDocument,
  page: PDFPage,
  image: HTMLImageElement,
  spotColors: SpotColorInput[],
  widthInches: number,
  heightInches: number,
  pageHeightInches: number,
  imageOffsetXInches: number,
  imageOffsetYInches: number,
  rotationDeg: number = 0,
): Promise<string[]> {
  if (!spotColors || spotColors.length === 0) return [];

  const hasWhite = spotColors.some(c => c.spotWhite);
  const hasGloss = spotColors.some(c => c.spotGloss);
  const hasFluor = spotColors.some(c => c.spotFluorY || c.spotFluorM || c.spotFluorG || c.spotFluorOrange);
  if (!hasWhite && !hasGloss && !hasFluor) return [];

  const regions = await traceColorRegionsAsync(image, spotColors, widthInches, heightInches);
  if (regions.length === 0) return [];

  const context = pdfDoc.context;
  const addedLabels: string[] = [];
  const ocgRefs: any[] = [];

  // Reuse existing OCGs for same-named regions across multiple designs
  const existingOcgTags = new Map<string, any>();
  try {
    const res = page.node.Resources();
    const props = res?.get(PDFName.of('Properties'));
    if (props instanceof PDFDict) {
      const entries = props.entries();
      for (const [key, val] of entries) {
        existingOcgTags.set(key.toString().replace('/', ''), val);
      }
    }
  } catch { /* first call, no properties yet */ }

  // Design center in canvas coords (Y-down)
  const designCx = imageOffsetXInches + widthInches / 2;
  const designCy = imageOffsetYInches + heightInches / 2;
  const rad = (-rotationDeg * Math.PI) / 180;
  const cosR = Math.cos(rad);
  const sinR = Math.sin(rad);

  for (const region of regions) {
    const offsetPaths = region.paths.map(path =>
      path.map(p => {
        // Image-relative to image-centered
        const relX = p.x - widthInches / 2;
        const relY = p.y - heightInches / 2;
        // Rotate around image center
        const rotX = relX * cosR - relY * sinR;
        const rotY = relX * sinR + relY * cosR;
        // Translate to absolute page coords, flip Y for PDF
        return {
          x: designCx + rotX,
          y: pageHeightInches - (designCy + rotY),
        };
      })
    );

    const ocgTag = `OC_${region.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
    let ocgRef = existingOcgTags.get(ocgTag);
    let isNewOcg = false;

    if (!ocgRef) {
      const ocgDict = context.obj({
        Type: PDFName.of('OCG'),
        Name: PDFHexString.fromText(region.name),
      });
      ocgRef = context.register(ocgDict);
      isNewOcg = true;
    }

    if (isNewOcg) {
      ocgRefs.push(ocgRef);
    }

    addSpotColorRegionAsLayer(pdfDoc, page, region, offsetPaths, ocgRef);
    if (!addedLabels.includes(region.name)) {
      addedLabels.push(region.name);
    }
  }

  if (ocgRefs.length === 0) return addedLabels;

  const catalog = pdfDoc.catalog;
  let ocProperties = catalog.get(PDFName.of('OCProperties'));
  if (!ocProperties) {
    const ocgsArray = context.obj([...ocgRefs]);
    const orderArray = context.obj([...ocgRefs]);
    const onArray = context.obj([...ocgRefs]);
    const dDict = context.obj({ ON: onArray, Order: orderArray, BaseState: PDFName.of('ON') });
    ocProperties = context.obj({ OCGs: ocgsArray, D: dDict });
    catalog.set(PDFName.of('OCProperties'), ocProperties);
  } else {
    const existingOCGs = (ocProperties as PDFDict).get(PDFName.of('OCGs'));
    if (existingOCGs instanceof PDFArray) {
      for (const ref of ocgRefs) existingOCGs.push(ref);
    }
    const dDict = (ocProperties as PDFDict).get(PDFName.of('D'));
    if (dDict instanceof PDFDict) {
      const order = dDict.get(PDFName.of('Order'));
      if (order instanceof PDFArray) {
        for (const ref of ocgRefs) order.push(ref);
      }
      const on = dDict.get(PDFName.of('ON'));
      if (on instanceof PDFArray) {
        for (const ref of ocgRefs) on.push(ref);
      }
    }
  }

  return addedLabels;
}
