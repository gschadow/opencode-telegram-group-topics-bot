import { describe, expect, it } from "vitest";
import {
  calculateModelsPaginationRange,
  parseModelPageCallback,
} from "../../../src/bot/handlers/model.js";

describe("bot/handlers/model", () => {
  describe("parseModelPageCallback", () => {
    it("parses valid page callbacks", () => {
      expect(parseModelPageCallback("model:page:0")).toBe(0);
      expect(parseModelPageCallback("model:page:12")).toBe(12);
    });

    it("returns null for non-page callbacks", () => {
      expect(parseModelPageCallback("model:ollama:qwen3.6")).toBeNull();
      expect(parseModelPageCallback("model:page:-1")).toBeNull();
      expect(parseModelPageCallback("model:page:abc")).toBeNull();
      expect(parseModelPageCallback("model:browse")).toBeNull();
    });
  });

  describe("calculateModelsPaginationRange", () => {
    it("returns first page bounds", () => {
      expect(calculateModelsPaginationRange(25, 0, 10)).toEqual({
        page: 0,
        totalPages: 3,
        startIndex: 0,
        endIndex: 10,
      });
    });

    it("clamps page to the last page", () => {
      expect(calculateModelsPaginationRange(25, 99, 10)).toEqual({
        page: 2,
        totalPages: 3,
        startIndex: 20,
        endIndex: 25,
      });
    });

    it("handles empty models list safely", () => {
      expect(calculateModelsPaginationRange(0, 0, 10)).toEqual({
        page: 0,
        totalPages: 1,
        startIndex: 0,
        endIndex: 0,
      });
    });

    it("applies < pageSize boundary semantics using provided pageSize (not fixed 10)", () => {
      expect(calculateModelsPaginationRange(6, 0, 7)).toEqual({
        page: 0,
        totalPages: 1,
        startIndex: 0,
        endIndex: 6,
      });
    });

    it("applies == pageSize boundary semantics using provided pageSize (single full page)", () => {
      expect(calculateModelsPaginationRange(7, 99, 7)).toEqual({
        page: 0,
        totalPages: 1,
        startIndex: 0,
        endIndex: 7,
      });
    });

    it("applies > pageSize boundary semantics using provided pageSize with overflow on next page", () => {
      expect(calculateModelsPaginationRange(8, 0, 7)).toEqual({
        page: 0,
        totalPages: 2,
        startIndex: 0,
        endIndex: 7,
      });

      expect(calculateModelsPaginationRange(8, 1, 7)).toEqual({
        page: 1,
        totalPages: 2,
        startIndex: 7,
        endIndex: 8,
      });
    });
  });
});