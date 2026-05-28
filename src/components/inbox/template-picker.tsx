"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { MessageTemplate } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  ChevronRight,
  LayoutTemplate,
  Loader2,
} from "lucide-react";

interface TemplatePickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (
    template: MessageTemplate,
    payload: {
      bodyParams: string[];
      bodyParameterObjects?: Array<{ type: "text"; text: string; parameter_name?: string }>;
      headerParameterObjects?: Array<{ type: "text"; text: string; parameter_name?: string }>;
      buttonParams?: {
        index: number;
        type: string;
        params: Array<{ type: "text"; text: string; parameter_name?: string }>;
      }[];
    },
  ) => void;
}

// Meta numbers template placeholders from 1 ({{1}}, {{2}}, …) and the
// indices passed to the Graph API must be contiguous starting at 1.
// We sort + dedupe here so a body using only {{2}} still drives a single
// input slot, and so render-order matches send-order.
function extractVariables(body: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const m of body.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
    const token = String(m[1]).trim();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  if (tokens.every((token) => /^\d+$/.test(token))) {
    return tokens.sort((a, b) => Number(a) - Number(b));
  }
  return tokens;
}

function renderBodyPreview(body: string, params: string[]): string {
  const variables = extractVariables(body);
  const indexByToken = new Map(variables.map((token, idx) => [token, idx]));
  return body.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, raw) => {
    const token = String(raw).trim();
    const idx = indexByToken.get(token);
    if (idx === undefined) return `{{${token}}}`;
    const value = params[idx];
    return value && value.trim().length > 0 ? value : `{{${token}}}`;
  });
}

interface TemplateField {
  key: string;
  label: string;
  target: "body" | "header" | "button";
  token: string;
  order: number;
  buttonIndex?: number;
  buttonType?: string;
}

function buildTextParameter(token: string, text: string) {
  return /^\d+$/.test(token)
    ? { type: "text" as const, text }
    : { type: "text" as const, text, parameter_name: token };
}

function buildTemplateFields(template: MessageTemplate): TemplateField[] {
  const fields: TemplateField[] = [];

  for (const [order, v] of extractVariables(template.body_text).entries()) {
    fields.push({
      key: `body-${v}`,
      label: `Body variable {{${v}}}`,
      target: "body",
      token: v,
      order,
    });
  }

  if (template.header_type === "text" && template.header_content) {
    for (const [order, v] of extractVariables(template.header_content).entries()) {
      fields.push({
        key: `header-${v}`,
        label: `Header variable {{${v}}}`,
        target: "header",
        token: v,
        order,
      });
    }
  }

  for (const [buttonIndex, button] of (template.buttons ?? []).entries()) {
    if ((button.type ?? "").toUpperCase() !== "URL" || !button.url) continue;
    for (const [order, v] of extractVariables(button.url).entries()) {
      fields.push({
        key: `button-${buttonIndex}-${v}`,
        label: `Button ${buttonIndex + 1} variable {{${v}}}`,
        target: "button",
        token: v,
        order,
        buttonIndex,
        buttonType: "url",
      });
    }
  }

  return fields;
}

export function TemplatePicker({
  open,
  onOpenChange,
  onSelect,
}: TemplatePickerProps) {
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<MessageTemplate | null>(null);
  const [paramValues, setParamValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    (async () => {
      setLoading(true);
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        if (!cancelled) {
          setTemplates([]);
          setLoading(false);
        }
        return;
      }

      // Only Approved templates are sendable through Meta — anything else
      // would 400 on the send route. Hide them rather than letting the
      // user pick a template that will be rejected.
      const { data, error } = await supabase
        .from("message_templates")
        .select("*")
        .eq("user_id", user.id)
        .eq("status", "Approved")
        .order("created_at", { ascending: false });

      if (cancelled) return;
      if (error) {
        console.error("Failed to fetch templates:", error);
        setTemplates([]);
      } else {
        setTemplates((data as MessageTemplate[]) ?? []);
      }
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [open]);

  function handleOpenChange(next: boolean) {
    if (!next) {
      setSelected(null);
      setParamValues({});
    }
    onOpenChange(next);
  }

  function pickTemplate(template: MessageTemplate) {
    const fields = buildTemplateFields(template);
    if (fields.length === 0) {
      onSelect(template, { bodyParams: [] });
      handleOpenChange(false);
      return;
    }
    setSelected(template);
    setParamValues(
      Object.fromEntries(fields.map((field) => [field.key, ""])),
    );
  }

  function confirm() {
    if (!selected) return;
    const fields = buildTemplateFields(selected);
    const bodyParams = fields
      .filter((field) => field.target === "body")
      .sort((a, b) => a.order - b.order)
      .map((field) => paramValues[field.key] ?? "");
    const bodyParameterObjects = fields
      .filter((field) => field.target === "body")
      .sort((a, b) => a.order - b.order)
      .map((field) => buildTextParameter(field.token, paramValues[field.key] ?? ""));
    const headerParameterObjects = fields
      .filter((field) => field.target === "header")
      .sort((a, b) => a.order - b.order)
      .map((field) => buildTextParameter(field.token, paramValues[field.key] ?? ""));
    const buttonParams = Array.from(
      new Map(
        fields
          .filter((field) => field.target === "button")
          .map((field) => [field.buttonIndex ?? -1, field.buttonType ?? "url"]),
      ),
    ).map(([buttonIndex, type]) => ({
      index: buttonIndex,
      type,
      params: fields
        .filter((field) => field.target === "button" && field.buttonIndex === buttonIndex)
        .sort((a, b) => a.order - b.order)
        .map((field) => buildTextParameter(field.token, paramValues[field.key] ?? "")),
    }));

    onSelect(selected, {
      bodyParams,
      bodyParameterObjects:
        bodyParameterObjects.length > 0 ? bodyParameterObjects : undefined,
      headerParameterObjects:
        headerParameterObjects.length > 0 ? headerParameterObjects : undefined,
      buttonParams: buttonParams.length > 0 ? buttonParams : undefined,
    });
    handleOpenChange(false);
  }

  const fields = selected ? buildTemplateFields(selected) : [];
  const canConfirm =
    !!selected &&
    fields.every((field) => (paramValues[field.key] ?? "").trim().length > 0);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="border-slate-700 bg-slate-900 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-white">
            <LayoutTemplate className="h-4 w-4 text-primary" />
            {selected ? selected.name : "Send template"}
          </DialogTitle>
          <DialogDescription className="text-slate-400">
            {selected
              ? "Fill in the placeholders to render this template. Meta requires every variable to be set."
              : "Pick an approved WhatsApp template to send to this contact."}
          </DialogDescription>
        </DialogHeader>

        {!selected ? (
          <div className="max-h-[60vh] space-y-2 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
              </div>
            ) : templates.length === 0 ? (
              <div className="rounded-md border border-slate-800 bg-slate-950/50 p-6 text-center">
                <p className="text-sm text-slate-300">No approved templates</p>
                <p className="mt-1 text-xs text-slate-500">
                  Approve a template in Meta WhatsApp Manager, then sync it
                  from Settings → Templates.
                </p>
              </div>
            ) : (
              templates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => pickTemplate(t)}
                  className="w-full rounded-md border border-slate-800 bg-slate-950/50 p-3 text-left transition-colors hover:border-primary/40 hover:bg-slate-900"
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-medium text-white">
                          {t.name}
                        </p>
                        <Badge className="border border-primary/30 bg-primary/20 text-[10px] text-primary">
                          {t.category}
                        </Badge>
                        {t.language && (
                          <span className="text-[10px] uppercase text-slate-500">
                            {t.language}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-slate-400">
                        {t.body_text}
                      </p>
                    </div>
                    <ChevronRight className="h-4 w-4 flex-shrink-0 text-slate-500" />
                  </div>
                </button>
              ))
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-md border border-slate-800 bg-slate-950/50 p-3">
              <p className="mb-1 text-xs text-slate-400">Preview</p>
              <p className="whitespace-pre-wrap text-sm text-slate-200">
                {renderBodyPreview(
                  selected.body_text,
                  fields
                    .filter((field) => field.target === "body")
                    .sort((a, b) => a.order - b.order)
                    .map((field) => paramValues[field.key] ?? ""),
                )}
              </p>
              {selected.footer_text && (
                <p className="mt-2 text-xs italic text-slate-500">
                  {selected.footer_text}
                </p>
              )}
            </div>
            {fields.map((field) => (
              <div key={field.key} className="space-y-1">
                <Label className="text-xs text-slate-300">{field.label}</Label>
                <Input
                  value={paramValues[field.key] ?? ""}
                  onChange={(e) => {
                    setParamValues((current) => ({
                      ...current,
                      [field.key]: e.target.value,
                    }));
                  }}
                  placeholder={field.label}
                  className="border-slate-700 bg-slate-800 text-white placeholder:text-slate-500"
                />
              </div>
            ))}
          </div>
        )}

        <DialogFooter className="gap-2">
          {selected ? (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  setSelected(null);
                  setParamValues({});
                }}
                className="border-slate-700 text-slate-300 hover:bg-slate-800"
              >
                <ArrowLeft className="h-4 w-4" />
                Back
              </Button>
              <Button
                disabled={!canConfirm}
                onClick={confirm}
                className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                Send template
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              onClick={() => handleOpenChange(false)}
              className="border-slate-700 text-slate-300 hover:bg-slate-800"
            >
              Cancel
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
