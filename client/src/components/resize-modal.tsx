import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/lib/i18n";
import { formatLength, formatDimensions, useMetric, cmToInches } from "@/lib/format-length";

interface ResizeModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (widthInches: number, heightInches: number) => void;
  detectedWidth: number;
  detectedHeight: number;
}

const QUICK_SIZES_INCHES = [2, 3, 4, 5];

export default function ResizeModal({
  open,
  onClose,
  onConfirm,
  detectedWidth,
  detectedHeight,
}: ResizeModalProps) {
  const { t, lang } = useLanguage();
  const metric = useMetric(lang);
  const aspectRatio = detectedWidth / detectedHeight;

  const [customSize, setCustomSize] = useState("3");

  useEffect(() => {
    if (open) {
      setCustomSize(metric ? "7.6" : "3");
    }
  }, [open, metric]);

  if (!open) return null;

  const handleSizeSelect = (sizeInches: number) => {
    let width: number, height: number;
    if (aspectRatio >= 1) {
      width = sizeInches;
      height = sizeInches / aspectRatio;
    } else {
      height = sizeInches;
      width = sizeInches * aspectRatio;
    }
    onConfirm(width, height);
  };

  const handleCustomConfirm = () => {
    const size = parseFloat(customSize);
    if (!isNaN(size) && size >= 0.5) {
      handleSizeSelect(size);
    }
  };

  const handleSkip = () => {
    onConfirm(detectedWidth, detectedHeight);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleCustomConfirm();
    }
  };

  const minInput = metric ? 1.27 : 0.5;
  const maxInput = metric ? 61 : 24;
  const stepInput = metric ? 0.5 : 0.25;

  const resultingSize = (() => {
    const parsed = parseFloat(customSize);
    if (isNaN(parsed)) return null;
    const sizeInches = metric ? cmToInches(parsed) : parsed;
    if (sizeInches < 0.5 || sizeInches > 24) return null;
    const w = aspectRatio >= 1 ? sizeInches : sizeInches * aspectRatio;
    const h = aspectRatio >= 1 ? sizeInches / aspectRatio : sizeInches;
    return formatDimensions(w, h, lang);
  })();

  const quickSizeLabel = (inches: number) =>
    metric ? formatLength(inches, lang) : `${inches}"`;

  return (
    <div className="w-full max-w-xl mx-auto">
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8">
        <h2 className="text-center text-lg font-semibold text-gray-800 mb-1">
          {t("resize.modalTitle")}
        </h2>
        <p className="text-sm text-gray-400 text-center mb-6">
          {metric ? t("resize.modalSubtitleCm") : t("resize.modalSubtitle")}
        </p>

        <div className="flex items-center gap-2 mb-1">
          <input
            type="number"
            step={stepInput}
            min={minInput}
            max={maxInput}
            value={customSize}
            onChange={(e) => setCustomSize(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 h-12 text-center text-xl font-medium bg-white border-2 border-gray-300 rounded-lg text-gray-700 focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 outline-none"
            placeholder={metric ? "7.6" : "Size"}
            autoFocus
          />
          <span className="text-xl text-gray-500 font-medium">
            {metric ? " cm" : '"'}
          </span>
          <Button
            onClick={handleCustomConfirm}
            className="h-12 px-6 bg-cyan-600 hover:bg-cyan-700 text-white font-medium"
          >
            {t("resize.applySize")}
          </Button>
        </div>
        {resultingSize && (
          <p className="text-xs text-gray-400 text-center mb-4">
            {t("resize.resultingSize")} {resultingSize}
          </p>
        )}
        {!resultingSize && <div className="mb-4" />}

        <div className="flex gap-2 justify-center mb-6">
          {QUICK_SIZES_INCHES.map((value) => (
            <button
              key={value}
              onClick={() =>
                setCustomSize(metric ? String((value * 2.54).toFixed(1)) : String(value))
              }
              className={`h-9 px-4 text-sm font-medium rounded-lg border transition-colors ${
                (metric
                  ? Math.abs(parseFloat(customSize) - value * 2.54) < 0.1
                  : parseFloat(customSize) === value)
                  ? "bg-cyan-600 border-cyan-600 text-white"
                  : "border-gray-200 text-gray-500 bg-gray-50 hover:bg-cyan-50 hover:border-cyan-300 hover:text-cyan-700"
              }`}
            >
              {quickSizeLabel(value)}
            </button>
          ))}
        </div>

        <div className="border-t border-gray-100 pt-5">
          <button
            onClick={handleSkip}
            className="w-full py-3.5 text-sm font-medium text-gray-600 bg-gray-50 hover:bg-gray-100 border-2 border-gray-200 hover:border-gray-300 rounded-xl transition-colors cursor-pointer"
          >
            {t("resize.skipKeepCurrent")}
            <span className="block text-xs text-gray-400 mt-0.5 font-normal">
              {formatDimensions(detectedWidth, detectedHeight, lang)}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
