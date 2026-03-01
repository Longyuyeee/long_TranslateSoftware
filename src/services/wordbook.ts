import { invoke } from "@tauri-apps/api/core";

export interface WordAnalysis {
  phonetic: string;
  meaning: string;
  etymology: string;
  examples: { en: string; zh: string }[];
  synonyms: string[];
  status?: "success" | "failed";
  error_msg?: string;
}

export async function checkWordExists(word: string): Promise<boolean> {
  return await invoke<boolean>("check_word_exists", { word });
}

export async function analyzeAndSaveWord(text: string): Promise<boolean> {
  try {
    // 1. 尝试在数据库创建记录（如果已存在则不会重复创建）
    await invoke("add_to_wordbook", { word: text });

    // 2. 获取配置
    const openaiKey = await invoke<string>("get_config_value", { key: "openai_api_key" });
    const transApiKey = await invoke<string>("get_config_value", { key: "trans_api_key" });
    const apiKey = (openaiKey || transApiKey || "").trim();

    if (!apiKey) {
        throw new Error("Missing API Key. Please check Model Config.");
    }

    const baseUrl = (await invoke<string>("get_config_value", { key: "base_url" }) || await invoke<string>("get_config_value", { key: "trans_base_url" }) || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
    const modelName = (await invoke<string>("get_config_value", { key: "model_name" }) || await invoke<string>("get_config_value", { key: "trans_model_name" }) || "deepseek-chat").trim();

    // 3. 更加专业的提示词模版 (明确要求中文)
    const prompt = `
      作为一名精通多国语言的语言学专家和翻译家，请对单词或短语 "${text}" 进行深度解析。
      请严格按照以下 JSON 格式返回结果，严禁包含任何 Markdown 代码块标签或额外文字：

      {
        "phonetic": "音标 (例如: /əˈnaɪ.lə.reɪt/)",
        "meaning": "准确、简洁的中文核心释义 (例如: 彻底消灭；湮灭)",
        "etymology": "词源故事或构词法分析 (必须使用中文，例如: 源自拉丁语 'an' (向) + 'nihil' (零)，意为化为乌有)",
        "examples": [
          {"en": "例句 1 (英文)", "zh": "例句 1 (准确的中文翻译)"},
          {"en": "例句 2 (英文)", "zh": "例句 2 (准确的中文翻译)"}
        ],
        "synonyms": ["近义词1", "近义词2", "近义词3"]
      }

      注意：所有解释性文字 (meaning, etymology, examples 中的 zh) 必须使用中文。
    `;

    const response = await fetch(`${baseUrl}/chat/completions`, {
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
