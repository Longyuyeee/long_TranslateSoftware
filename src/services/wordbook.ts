import { invoke } from "@tauri-apps/api/core";

const FETCH_TIMEOUT_MS = 60000;

function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timeoutId));
}

export interface WordAnalysis {
  phonetic: string;
  meaning: string;
  etymology: string;
  mnemonic: string;
  examples: { en: string; zh: string }[];
  synonyms: string[];
  status?: "success" | "failed";
  error_msg?: string;
}

export interface WordContextInput {
  sourceText: string;
  translatedText?: string;
  sourceType: "selection" | "ocr" | "manual";
}

export interface SavedWordContext {
  id: number;
  source_text: string;
  translated_text: string;
  source_type: string;
  created_at: string;
}

export interface WordbookEntry {
  id: number;
  uuid: string;
  word: string;
  phonetic: string;
  meaning: string;
  analysis: string;
  created_at: string;
  contexts: SavedWordContext[];
}

export type WordbookSort = "newest" | "az" | "za";

export interface WordbookPage<T = WordbookEntry> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export async function getWordbookPage<T = any>(options: {
  query?: string;
  sort?: WordbookSort;
  limit?: number;
  offset?: number;
} = {}): Promise<WordbookPage<T>> {
  return await invoke<WordbookPage<T>>("get_wordbook_page", {
    query: options.query || "",
    sort: options.sort || "newest",
    limit: options.limit ?? 100,
    offset: options.offset ?? 0,
  });
}

export async function checkWordExists(word: string): Promise<boolean> {
  return await invoke<boolean>("check_word_exists", { word });
}

export async function analyzeAndSaveWord(text: string, context?: WordContextInput): Promise<boolean> {
  try {
    const alreadyExists = await checkWordExists(text);
    // 1. 尝试在数据库创建记录（如果已存在则不会重复创建）
    await invoke("add_to_wordbook", {
      word: text,
      context: context ? {
        sourceText: context.sourceText,
        translatedText: context.translatedText,
        sourceType: context.sourceType,
      } : undefined,
    });
    if (alreadyExists) return true;

    // 2. 获取配置
    const config = await invoke<Record<string, string>>("get_config_values", { keys: [
      "openai_api_key", "trans_api_key", "base_url", "trans_base_url", "model_name", "trans_model_name",
    ] });
    const apiKey = (config.trans_api_key || config.openai_api_key || "").trim();

    if (!apiKey) {
        throw new Error("Missing API Key. Please check Model Config.");
    }

    const baseUrl = (config.trans_base_url || config.base_url || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
    const modelName = (config.trans_model_name || config.model_name || "deepseek-chat").trim();

    // 3. 更加专业的提示词模版 (明确要求中文)
    const prompt = `
      作为一名精通多国语言的语言学专家和翻译家，请对单词或短语 "${text}" 进行深度解析。
      请严格按照以下 JSON 格式返回结果，严禁包含任何 Markdown 代码块标签或额外文字：

      {
        "phonetic": "音标 (例如: /əˈnaɪ.lə.reɪt/)",
        "meaning": "准确、简洁的中文核心释义 (例如: 彻底消灭；湮灭)",
        "etymology": "词源故事或构词法分析 (必须使用中文，例如: 源自拉丁语 'an' (向) + 'nihil' (零)，意为化为乌有)",
        "mnemonic": "一个实用的记忆技巧或联想方法 (必须使用中文，例如: annihilate → 谐音 '俺奶吃哩' — 因为太饿了，把奶奶的饭都消灭光啦！注意：请提供巧妙的谐音、拆分、联想或故事法来帮助记忆)",
        "examples": [
          {"en": "例句 1 (英文)", "zh": "例句 1 (准确的中文翻译)"},
          {"en": "例句 2 (英文)", "zh": "例句 2 (准确的中文翻译)"}
        ],
        "synonyms": ["近义词1", "近义词2", "近义词3"]
      }

      注意：所有解释性文字 (meaning, etymology, mnemonic, examples 中的 zh) 必须使用中文。
      mnemonic 是帮助记忆的关键，请务必提供有趣、好记的中文联想！
    `;

    const response = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelName,
        messages: [
          { role: "system", content: "你是一个专业的语言学专家，只输出纯 JSON 格式。" },
          { role: "user", content: prompt }
        ],
        temperature: 0.3,
      }),
    });

    if (!response.ok) throw new Error(`API ${response.status}: ${response.statusText}`);

    const data = await response.json();
    let content = data.choices[0].message.content.trim();
    
    // 鲁棒的 JSON 提取
    if (content.includes("{")) {
        const start = content.indexOf("{");
        const end = content.lastIndexOf("}") + 1;
        content = content.slice(start, end);
    }
    
    const result: WordAnalysis = JSON.parse(content);
    result.status = "success";

    await invoke("update_word_analysis", {
      word: text,
      phonetic: result.phonetic,
      meaning: result.meaning,
      analysis: JSON.stringify(result)
    });

    return true;
  } catch (error: any) {
    console.error("Analysis Error:", error);
    await invoke("update_word_analysis", {
        word: text,
        phonetic: "?",
        meaning: "Analysis Failed",
        analysis: JSON.stringify({
            status: "failed",
            error_msg: error instanceof Error ? error.message : String(error)
        })
    });
    return false;
  }
}
