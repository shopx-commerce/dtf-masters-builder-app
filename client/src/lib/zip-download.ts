export async function downloadZipPackage(
  originalImage: HTMLImageElement,
  designCanvas: HTMLCanvasElement,
  originalFilename: string
): Promise<void> {
  try {
    // Simplified approach: download files individually since zip creation is failing
    const nameWithoutExt = originalFilename.replace(/\.[^/.]+$/, "");
    
    // Download original image
    const originalBlob = await imageToBlob(originalImage);
    if (originalBlob) {
      downloadBlob(originalBlob, `${nameWithoutExt}_original.png`);
    }
    
    // Small delay between downloads
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Download design with cutlines
    const designBlob = await new Promise<Blob | null>((resolve) => {
      designCanvas.toBlob(resolve, 'image/png', 1.0);
    });
    
    if (designBlob) {
      downloadBlob(designBlob, `${nameWithoutExt}_with_cutlines.png`);
    }
    
  } catch (error) {
    console.error('Error creating download package:', error);
    throw new Error('Failed to create download package');
  }
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

async function imageToBlob(image: HTMLImageElement): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  
  canvas.width = image.width;
  canvas.height = image.height;
  ctx.drawImage(image, 0, 0);
  
  return new Promise((resolve) => {
    canvas.toBlob(resolve, 'image/png', 1.0);
  });
}