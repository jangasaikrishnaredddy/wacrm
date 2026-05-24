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
      headerParams?: string[];
      buttonParams?: { index: number; type: string; params: string[] }[];
    },
  ) => void;
}

// Meta numbers template placeholders from 1 ({{1}}, {{2}}, …) and the
// indices passed to the Graph API must be contiguous starting at 1.
// We sort + dedupe here so a body using only {{2}} still drives a single
// input slot, and so render-order matches send-order.
function extractVariables(body: string): number[] {
  const ids = new Set<number>();
  for (const m of body.matchAll(/\{\{(\d+)\}\}/g)) {
    ids.add(Number(m[1]));
  }
  return Array.from(ids).sort((a, b) => a - b);
}

function renderBodyPreview(body: string, params: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_, raw) => {
    const idx = Number(raw) - 1;
    const value = params[idx];
    return value && value.trim().length > 0 ? value : `{{${raw}}}`;
  });
}

interface TemplateField {
  key: string;
  label: string;
  target: "body" | "header" | "button";
  index: number;
  buttonIndex?: number;
  buttonType?: string;
}

function buildTemplateFields(template: MessageTemplate): TemplateField[] {
  const fields: TemplateField[] = [];

  for (const v of extractVariables(template.body_text)) {
    fields.push({
      key: `body-${v}`,
      label: `Body variable {{${v}}}`,
      target: "body",
      index: v,
    });
  }

  if (template.header_type === "text" && template.header_content) {
    for (const v of extractVariables(template.header_content)) {
      fields.push({
        key: `header-${v}`,
        label: `Header variable {{${v}}}`,
        target: "header",
        index: v,
      });
    }
  }

  for (const [buttonIndex, button] of (template.buttons ?? []).entries()) {
    if ((button.type ?? "").toUpperCase() !== "URL" || !button.url) continue;
    for (const v of extractVariables(button.url)) {
      fields.push({
        key: `button-${buttonIndex}-${v}`,
        label: `Button ${buttonIndex + 1} variable {{${v}}}`,
        target: "button",
        index: v,
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
      .sort((a, b) => a.index - b.index)
      .map((field) => paramValues[field.key] ?? "");
    const headerParams = fields
      .filter((field) => field.target === "header")
      .sort((a, b) => a.index - b.index)
      .map((field) => paramValues[field.key] ?? "");
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
        .sort((a, b) => a.index - b.index)
        .map((field) => paramValues[field.key] ?? ""),
    }));

    onSelect(selected, {
      bodyParams,
      headerParams: headerParams.length > 0 ? headerParams : undefined,
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
                    .sort((a, b) => a.index - b.index)
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
