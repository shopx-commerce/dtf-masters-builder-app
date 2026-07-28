import ImageEditor from "@/components/image-editor";
import { HOT_PEEL_PROFILE } from "@/lib/profiles";

export default function EmbedPage() {
  return (
    <div className="w-full h-[800px] max-h-screen bg-gradient-to-br from-slate-800 via-slate-900 to-slate-800 overflow-hidden">
      <div className="w-full h-full p-2">
        <ImageEditor profile={HOT_PEEL_PROFILE} />
      </div>
    </div>
  );
}
