// ChatGPT UI message 7l/KIT, checked against its public locale resources on 2026-09-12.
// These are exact terminal status labels, not translations inferred from model response text.
// Locale module index: https://chatgpt.com/cdn/assets/70025534-vzdih64izbkkpexj.js
export const CHATGPT_STOPPED_THINKING_LABELS = [
  "ማሰብ ቆሟል", // am
  "توقّف التفكير", // ar
  "Спря да мисли", // bg-BG
  "চিন্তা থেমেছে", // bn-BD
  "Razmišljanje prekinuto", // bs-BA
  "Pensament interromput", // ca-ES
  "Přemýšlení zastaveno", // cs-CZ
  "Tænkning stoppet", // da-DK
  "Denken gestoppt", // de-DE
  "Διακόπηκε η σκέψη", // el-GR
  "Stopped thinking", // en-US
  "Dejó de pensar", // es-419, es-ES
  "Mõtlemine peatati", // et-EE
  "فرایند فکر کردن متوقف شد", // fa
  "Ajattelu pysähtyi", // fi-FI
  "Réflexion interrompue", // fr-CA, fr-FR
  "વિચાર કરવાનું બંધ થયું", // gu-IN
  "सोचना बंद हो गया", // hi-IN
  "Razmišljanje je zaustavljeno", // hr-HR
  "Gondolkodás leállítva", // hu-HU
  "Մտածելու գործընթացը դադարեցվեց", // hy-AM
  "Berhenti berpikir", // id-ID
  "Hætti að hugsa", // is-IS
  "Elaborazione interrotta", // it-IT
  "思考を停止しました", // ja-JP
  "ფიქრი შეწყდა", // ka-GE
  "Ойлану тоқтатылды", // kk
  "ಯೋಚನೆ ನಿಂತಿತು", // kn-IN
  "생각 중지됨", // ko-KR
  "Nustota mąstyti", // lt
  "Pārtrauca domāt", // lv-LV
  "Престана да размислува", // mk-MK
  "ചിന്തിക്കുന്നത് നിർത്തി", // ml
  "Бодохоо больсон", // mn
  "विचार करणे थांबवले", // mr-IN
  "Berhenti berfikir", // ms-MY
  "စဉ်းစားမှု ရပ်သွားသည်", // my-MM
  "Sluttet å tenke", // nb-NO
  "Het nadenken is gestopt", // nl-NL
  "ਸੋਚਣਾ ਰੁਕ ਗਿਆ", // pa
  "Przerwano myślenie", // pl-PL
  "Pensamento interrompido", // pt-BR, pt-PT
  "Analiza s-a oprit", // ro-RO
  "Рассуждение остановлено", // ru-RU
  "Premýšľanie sa zastavilo", // sk-SK
  "Razmišljanje ustavljeno", // sl-SI
  "Fikirka waa la joojiyay", // so-SO
  "Ndaloi së menduari", // sq-AL
  "Размишљање је прекинуто", // sr-RS
  "Slutade att tänka", // sv-SE
  "Imeacha kufikiri", // sw-TZ
  "யோசனை நிறுத்தப்பட்டது", // ta-IN
  "ఆలోచించడం ఆగింది", // te-IN
  "หยุดคิดแล้ว", // th-TH
  "Huminto sa pag-iisip", // tl
  "Düşünme durdu", // tr-TR
  "Обдумування зупинено", // uk-UA
  "سوچنا بند کر دیا", // ur
  "Đã ngừng suy nghĩ", // vi-VN
  "已停止思考", // zh-CN, zh-HK
  "已中斷思考", // zh-TW
] as const;

export const CHATGPT_PERSONALIZED_BUTTON_PATTERN =
  /^(?:Personalized|Personalizované|Personalizado|Personalisiert|Personnalisé|Personalizzato|Spersonalizowane|Gepersonaliseerd|Персонализированный|Персоналізований|Kişiselleştirilmiş|パーソナライズ|맞춤 설정됨|个性化|個人化)$/i;

export const CHATGPT_UNPERSONALIZED_BUTTON_PATTERN =
  /^(?:Unpersonalized|Nepersonalizované|No personalizado|Não personalizado|Nicht personalisiert|Non personnalisé|Non personalizzato|Niespersonalizowane|Niet gepersonaliseerd|Неперсонализированный|Неперсоналізований|Kişiselleştirilmemiş|非パーソナライズ|맞춤 설정되지 않음|非个性化|非個人化)$/i;

export const CHATGPT_PERSONALIZED_CHOICE_PATTERN =
  /^(?:Personalized|Personalizované|Personalizado|Personalisiert|Personnalisé|Personalizzato|Spersonalizowane|Gepersonaliseerd|Персонализированный|Персоналізований|Kişiselleştirilmiş|パーソナライズ|맞춤 설정됨|个性化|個人化)/i;

