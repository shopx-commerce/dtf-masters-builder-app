import { useCallback, useState } from "react";
import { Upload, Zap, Shield, Droplets, Sun, MapPin, CheckCircle2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { ImageInfo } from "./image-editor";
import type { ResizeSettings } from "@/lib/types";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";

export interface StickerOptions {
  size: string;
  quantity: number;
}

interface UploadSectionProps {
  onImageUpload: (file: File, image: HTMLImageElement, options?: StickerOptions) => void;
  imageInfo: ImageInfo | null;
  resizeSettings: ResizeSettings;
  showCutLineInfo?: boolean;
  isCompactEmbed?: boolean;
}

export default function UploadSection({ onImageUpload, imageInfo, resizeSettings, showCutLineInfo = false, isCompactEmbed = false }: UploadSectionProps) {
  const [selectedSize, setSelectedSize] = useState<string>("");
  const [quantity, setQuantity] = useState<number>(25);
  
  const handleFileUpload = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) {
      alert('Please upload an image file (PNG or JPEG).');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const options: StickerOptions | undefined = isCompactEmbed && selectedSize 
          ? { size: selectedSize, quantity } 
          : undefined;
        onImageUpload(file, img, options);
      };
      img.src = e.target?.result as string;
    };
    reader.readAsDataURL(file);
  }, [onImageUpload, isCompactEmbed, selectedSize, quantity]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleFileUpload(files[0]);
    }
  }, [handleFileUpload]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFileUpload(e.target.files[0]);
    }
  }, [handleFileUpload]);

  const trustBadges = [
    { icon: Droplets, text: "Waterproof & Scratch Resistant" },
    { icon: Sun, text: "Outdoor Durable 3–5 Years" },
    { icon: Zap, text: "No Minimum Orders" },
    { icon: Shield, text: "Free Proof Before Printing" },
    { icon: MapPin, text: "Printed in California" },
  ];

  return (
    <div>
      <div className="text-center mb-6">
        <h1 className="text-2xl md:text-3xl font-heading font-bold tracking-wide uppercase mb-2" style={{ color: "#111827" }}>
          Turn Your Logo Into Waterproof Vinyl Stickers
        </h1>
        <p className="text-sm" style={{ color: "#6B7280" }}>
          Upload your design and get professional-quality stickers printed in 24–48 hours.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-5 gap-6 items-stretch">
        <div className="md:col-span-3">
          <div 
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onClick={() => document.getElementById('imageInput')?.click()}
            className="rounded-2xl p-8 text-center transition-all duration-300 cursor-pointer group relative overflow-hidden h-full flex flex-col items-center justify-center"
            style={{
              backgroundColor: "rgba(37, 99, 235, 0.04)",
              border: "2px dashed #2563EB",
              boxShadow: "0 0 30px rgba(37, 99, 235, 0.15), inset 0 0 30px rgba(37, 99, 235, 0.03)",
              minHeight: "280px",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.boxShadow = "0 0 50px rgba(37, 99, 235, 0.3), inset 0 0 40px rgba(37, 99, 235, 0.06)";
              e.currentTarget.style.borderColor = "#60A5FA";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.boxShadow = "0 0 30px rgba(37, 99, 235, 0.15), inset 0 0 30px rgba(37, 99, 235, 0.03)";
              e.currentTarget.style.borderColor = "#2563EB";
            }}
          >
            <div className="flex flex-col items-center relative z-10">
              <div
                className="w-20 h-20 rounded-full flex items-center justify-center mb-4 group-hover:scale-110 transition-transform duration-300"
                style={{
                  background: "linear-gradient(135deg, rgba(37, 99, 235, 0.15) 0%, rgba(96, 165, 250, 0.1) 100%)",
                  boxShadow: "0 0 25px rgba(37, 99, 235, 0.2)",
                }}
              >
                <Upload className="w-10 h-10 group-hover:text-blue-300 transition-colors duration-300" style={{ color: "#60A5FA" }} />
              </div>
              <h3 className="text-xl font-bold mb-1 font-heading tracking-wide" style={{ color: "#111827" }}>Upload Your Design</h3>
              <p className="text-sm mb-1" style={{ color: "#6B7280" }}>Drag & Drop or Click to Upload</p>
              <p className="text-xs mb-5" style={{ color: "#9CA3AF" }}>We automatically generate the cutline and preview instantly.</p>
              <button
                className="px-8 py-3 rounded-xl text-base font-bold flex items-center gap-2 transition-all duration-300 group-hover:scale-105"
                style={{
                  background: "linear-gradient(135deg, #2563EB 0%, #1D4ED8 100%)",
                  color: "#FFFFFF",
                  boxShadow: "0 4px 20px rgba(37, 99, 235, 0.4)",
                }}
              >
                <Upload className="w-5 h-5" />
                Upload Your Design
              </button>
              <p className="text-xs mt-3" style={{ color: "#9CA3AF" }}>PNG, JPG — works best with transparent backgrounds</p>
            </div>
            <input 
              type="file" 
              id="imageInput" 
              className="hidden" 
              accept=".png,.jpg,.jpeg,image/png,image/jpeg" 
              onChange={handleFileInputChange}
            />
          </div>
        </div>

        <div className="md:col-span-2 flex flex-col justify-center">
          <div className="rounded-2xl p-5 space-y-4" style={{ backgroundColor: "#F8FAFC", border: "1px solid #E2E8F0" }}>
            <p className="text-xs font-bold uppercase tracking-wider" style={{ color: "#60A5FA" }}>
              Production-Grade Die Cut Stickers. Fast Turnaround.
            </p>
            <div className="space-y-3">
              {trustBadges.map((badge, i) => (
                <div key={i} className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: "rgba(37, 99, 235, 0.1)" }}>
                    <badge.icon className="w-4 h-4" style={{ color: "#2563EB" }} />
                  </div>
                  <span className="text-sm font-medium" style={{ color: "#374151" }}>{badge.text}</span>
                </div>
              ))}
            </div>
            <div className="pt-2" style={{ borderTop: "1px solid #E2E8F0" }}>
              <div className="flex items-center gap-2">
                <div className="flex -space-x-1">
                  {[...Array(5)].map((_, i) => (
                    <svg key={i} className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="#FBBF24"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" /></svg>
                  ))}
                </div>
                <span className="text-xs font-semibold" style={{ color: "#6B7280" }}>4.9/5 from 2,000+ orders</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
