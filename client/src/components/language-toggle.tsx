import { useLanguage, type Language } from "@/lib/i18n";

const LANGUAGES: { code: Language; label: string }[] = [
  { code: "en", label: "EN" },
  { code: "es", label: "ES" },
  { code: "fr", label: "FR" },
];

export default function LanguageToggle({ className = "" }: { className?: string }) {
  const { lang, setLang } = useLanguage();

  return (
    <div className={`inline-flex items-center gap-1 ${className}`}>
      {LANGUAGES.map(({ code, label }, i) => (
        <span key={code} className="inline-flex items-center">
          {i > 0 && <span className="text-gray-400 mx-0.5 text-[10px]">|</span>}
          <button
            onClick={() => setLang(code)}
            className={`text-[11px] font-medium px-1 py-0.5 rounded transition-colors ${
              lang === code
                ? "text-cyan-600 font-semibold"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {label}
          </button>
        </span>
      ))}
    </div>
  );
}
