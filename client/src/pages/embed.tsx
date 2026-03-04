import ImageEditor from "@/components/image-editor";

export default function EmbedPage() {
  return (
    <div className="w-full h-[800px] max-h-screen bg-gradient-to-br from-slate-800 via-slate-900 to-slate-800 overflow-hidden">
      <div className="w-full h-full p-2">
        <ImageEditor />
      </div>
    </div>
  );
}
