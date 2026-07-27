import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  analyzeAndSaveWord,
  getWordbookPage,
  WordbookEntry,
  WordbookSort,
} from "../services/wordbook";

const PAGE_SIZE = 100;
const FILTER_DEBOUNCE_MS = 250;

interface LoadWordbookOptions {
  query?: string;
  sort?: WordbookSort;
  offset?: number;
  append?: boolean;
}

interface UseWordbookOptions {
  onChanged?: () => void;
}

export function useWordbook({ onChanged }: UseWordbookOptions = {}) {
  const [words, setWords] = useState<WordbookEntry[]>([]);
  const [selectedWord, setSelectedWord] = useState<WordbookEntry | null>(null);
  const [wordbookTotal, setWordbookTotal] = useState(0);
  const [wordbookHasMore, setWordbookHasMore] = useState(false);
  const [isWordbookLoading, setIsWordbookLoading] = useState(false);
  const [wordbookSearch, setWordbookSearch] = useState("");
  const [wordbookSort, setWordbookSort] = useState<WordbookSort>("newest");
  const [newWord, setNewWord] = useState("");
  const [isAdding, setIsAdding] = useState(false);

  const mountedRef = useRef(true);
  const loadingRef = useRef(false);
  const appliedFilterRef = useRef({ search: "", sort: "newest" as WordbookSort });
  const requestIdRef = useRef(0);
  const searchRef = useRef("");
  const sortRef = useRef<WordbookSort>("newest");
  const selectedWordRef = useRef<WordbookEntry | null>(null);
  const onChangedRef = useRef(onChanged);

  useEffect(() => {
    onChangedRef.current = onChanged;
  }, [onChanged]);

  useEffect(() => {
    selectedWordRef.current = selectedWord;
  }, [selectedWord]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
    };
  }, []);

  const loadWordbook = useCallback(async ({
    query,
    sort,
    offset = 0,
    append = false,
  }: LoadWordbookOptions = {}) => {
    if (append && loadingRef.current) return;

    const requestId = ++requestIdRef.current;
    loadingRef.current = true;
    setIsWordbookLoading(true);
    try {
      const page = await getWordbookPage<WordbookEntry>({
        query: query ?? searchRef.current,
        sort: sort ?? sortRef.current,
        limit: PAGE_SIZE,
        offset,
      });
      if (!mountedRef.current || requestId !== requestIdRef.current) return;

      setWords((current) => append ? [...current, ...page.items] : page.items);
      setWordbookTotal(page.total);
      setWordbookHasMore(page.hasMore);

      const currentSelection = selectedWordRef.current;
      if (currentSelection) {
        const updated = page.items.find(
          (word) => word.uuid === currentSelection.uuid || word.id === currentSelection.id,
        );
        if (updated) setSelectedWord(updated);
      }
    } catch (error) {
      console.error(error);
    } finally {
      if (mountedRef.current && requestId === requestIdRef.current) {
        loadingRef.current = false;
        setIsWordbookLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    searchRef.current = wordbookSearch;
    sortRef.current = wordbookSort;
    const applied = appliedFilterRef.current;
    if (applied.search === wordbookSearch && applied.sort === wordbookSort) {
      return;
    }
    appliedFilterRef.current = { search: wordbookSearch, sort: wordbookSort };
    const timer = window.setTimeout(() => {
      void loadWordbook({ query: wordbookSearch, sort: wordbookSort });
    }, FILTER_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [loadWordbook, wordbookSearch, wordbookSort]);

  const loadMore = useCallback(() => {
    void loadWordbook({ offset: words.length, append: true });
  }, [loadWordbook, words.length]);

  const deleteWord = useCallback(async (id: number) => {
    await invoke("delete_word", { id });
    if (selectedWordRef.current?.id === id) {
      selectedWordRef.current = null;
      setSelectedWord(null);
    }
    onChangedRef.current?.();
  }, []);

  const addManualWord = useCallback(async () => {
    const word = newWord.trim();
    if (!word) return;
    setNewWord("");
    setIsAdding(false);
    await analyzeAndSaveWord(word);
  }, [newWord]);

  const cancelAdding = useCallback(() => {
    setIsAdding(false);
    setNewWord("");
  }, []);

  const retrySelectedAnalysis = useCallback(async () => {
    const word = selectedWordRef.current;
    if (!word) return;
    const pending = { ...word, analysis: "" };
    selectedWordRef.current = pending;
    setSelectedWord(pending);
    await analyzeAndSaveWord(word.word);
  }, []);

  return {
    words,
    selectedWord,
    setSelectedWord,
    wordbookTotal,
    wordbookHasMore,
    isWordbookLoading,
    wordbookSearch,
    setWordbookSearch,
    wordbookSort,
    setWordbookSort,
    newWord,
    setNewWord,
    isAdding,
    setIsAdding,
    loadWordbook,
    loadMore,
    deleteWord,
    addManualWord,
    cancelAdding,
    retrySelectedAnalysis,
  };
}
