import {
  type LandingSettings,
  type LandingTemplate,
  landingSettings,
  landingTemplates,
} from "@edgeweir/contract";
import { LinkSquare02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { ErrorState, LoadingState } from "@/components/states";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";
import { cn } from "@/lib/utils";
// The template palettes, for the thumbnails.
import "./landing/landing.css";

const templateLabels: Record<LandingTemplate, { name: () => string; hint: () => string }> = {
  none: { name: m.landing_template_none, hint: m.landing_template_none_hint },
  horizon: { name: m.landing_template_horizon, hint: m.landing_template_horizon_hint },
  orbit: { name: m.landing_template_orbit, hint: m.landing_template_orbit_hint },
};

/** Admin card: which landing page `/` shows, and the brand details it renders. */
export function LandingSettingsCard() {
  const landing = useQuery(orpc.landing.get.queryOptions());
  return (
    <Card className="animate-enter" style={{ animationDelay: "80ms" }}>
      <CardHeader>
        <CardTitle>{m.landing_settings_title()}</CardTitle>
      </CardHeader>
      <CardContent>
        {landing.isPending ? (
          <LoadingState />
        ) : landing.isError ? (
          <ErrorState error={landing.error} onRetry={() => landing.refetch()} />
        ) : (
          <LandingForm initial={landing.data.settings} />
        )}
      </CardContent>
    </Card>
  );
}

type Errors = Partial<Record<keyof LandingSettings, string>>;

function LandingForm({ initial }: { initial: LandingSettings }) {
  const queryClient = useQueryClient();
  const [values, setValues] = React.useState(initial);
  const [errors, setErrors] = React.useState<Errors>({});
  const save = useMutation(orpc.landing.update.mutationOptions());
  const set = <K extends keyof LandingSettings>(key: K, value: LandingSettings[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  };
  const text = (key: "brandName" | "headline" | "contactEmail" | "signupUrl" | "icp") => ({
    id: `landing-${key}`,
    value: values[key],
    "aria-invalid": errors[key] ? true : undefined,
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => set(key, event.target.value),
  });

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const parsed = landingSettings.safeParse(values);
    if (!parsed.success) {
      const next: Errors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof LandingSettings;
        next[key] ??= m.landing_settings_invalid();
      }
      setErrors(next);
      return;
    }
    try {
      const saved = await save.mutateAsync(parsed.data);
      setValues(saved);
      await queryClient.invalidateQueries({ queryKey: orpc.landing.key() });
      toast.success(m.common_saved());
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  return (
    <form className="flex flex-col gap-6" onSubmit={onSubmit} noValidate>
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-3 text-sm font-medium">{m.landing_settings_template()}</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          {landingTemplates.map((template) => (
            <label
              key={template}
              className={cn(
                "group flex cursor-pointer flex-col gap-3 rounded-2xl border p-3 transition-[border-color,box-shadow] hover:border-foreground/30",
                "has-checked:border-primary has-checked:ring-3 has-checked:ring-primary/20 has-focus-visible:ring-3 has-focus-visible:ring-ring/30",
              )}
            >
              <input
                type="radio"
                name="landing-template"
                value={template}
                checked={values.template === template}
                onChange={() => set("template", template)}
                className="sr-only"
                data-testid={`landing-template-${template}`}
              />
              <TemplateThumb template={template} />
              <span className="px-1">
                <span className="block text-sm font-medium">{templateLabels[template].name()}</span>
                <span className="block text-xs text-muted-foreground">
                  {templateLabels[template].hint()}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <FieldGroup className="grid gap-5 sm:grid-cols-2">
        <Field data-invalid={!!errors.brandName || undefined}>
          <FieldLabel htmlFor="landing-brandName">{m.landing_settings_brand()}</FieldLabel>
          <Input {...text("brandName")} maxLength={60} required />
          {errors.brandName ? <FieldError>{errors.brandName}</FieldError> : null}
        </Field>
        <Field data-invalid={!!errors.contactEmail || undefined}>
          <FieldLabel htmlFor="landing-contactEmail">{m.landing_settings_contact()}</FieldLabel>
          <Input {...text("contactEmail")} type="email" maxLength={200} />
          {errors.contactEmail ? <FieldError>{errors.contactEmail}</FieldError> : null}
        </Field>
        <Field className="sm:col-span-2" data-invalid={!!errors.headline || undefined}>
          <FieldLabel htmlFor="landing-headline">{m.landing_settings_headline()}</FieldLabel>
          <Input {...text("headline")} maxLength={120} placeholder={m.landing_default_headline()} />
          {errors.headline ? <FieldError>{errors.headline}</FieldError> : null}
        </Field>
        <Field className="sm:col-span-2" data-invalid={!!errors.description || undefined}>
          <FieldLabel htmlFor="landing-description">{m.landing_settings_description()}</FieldLabel>
          <Textarea
            id="landing-description"
            value={values.description}
            maxLength={300}
            aria-invalid={errors.description ? true : undefined}
            placeholder={m.landing_default_description({ brand: values.brandName })}
            onChange={(event) => set("description", event.target.value)}
          />
          {errors.description ? <FieldError>{errors.description}</FieldError> : null}
        </Field>
        <Field data-invalid={!!errors.signupUrl || undefined}>
          <FieldLabel htmlFor="landing-signupUrl">{m.landing_settings_signup_url()}</FieldLabel>
          <Input {...text("signupUrl")} type="url" maxLength={500} placeholder="https://" />
          {errors.signupUrl ? <FieldError>{errors.signupUrl}</FieldError> : null}
        </Field>
        <Field data-invalid={!!errors.icp || undefined}>
          <FieldLabel htmlFor="landing-icp">{m.landing_settings_icp()}</FieldLabel>
          <Input {...text("icp")} maxLength={60} />
          {errors.icp ? <FieldError>{errors.icp}</FieldError> : null}
        </Field>
      </FieldGroup>

      <Field orientation="horizontal">
        <Switch
          id="landing-showStats"
          checked={values.showStats}
          onCheckedChange={(checked) => set("showStats", checked)}
          data-testid="landing-show-stats"
        />
        <FieldLabel htmlFor="landing-showStats">{m.landing_settings_show_stats()}</FieldLabel>
      </Field>

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={save.isPending} data-testid="landing-save">
          {save.isPending ? <Spinner /> : null}
          {m.common_save()}
        </Button>
        {values.template !== "none" ? (
          <a
            href={`/?preview=${values.template}`}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ variant: "outline" })}
            data-testid="landing-preview"
          >
            <HugeiconsIcon icon={LinkSquare02Icon} strokeWidth={2} />
            {m.landing_settings_preview()}
          </a>
        ) : null}
      </div>
    </form>
  );
}

/** A miniature of each template's look, drawn with plain blocks in the template's palette. */
function TemplateThumb({ template }: { template: LandingTemplate }) {
  const frame =
    "relative aspect-[16/10] w-full overflow-hidden rounded-xl ring-1 ring-foreground/10 transition-transform duration-300 group-hover:scale-[1.02] motion-reduce:transition-none";
  if (template === "horizon") {
    return (
      <span
        aria-hidden="true"
        className={cn(frame, "landing-horizon-palette flex flex-col bg-(--hz-paper)")}
      >
        <span className="h-[9%] border-b border-black/10 bg-white" />
        <span className="relative h-[52%] overflow-hidden bg-black p-[7%]">
          <span className="absolute -right-[18%] -bottom-[70%] size-[90%] rounded-full bg-[radial-gradient(circle,var(--hz-orange)_0%,var(--hz-magenta)_35%,var(--hz-violet)_55%,transparent_70%)] opacity-80 blur-md" />
          <span className="block h-[14%] w-[55%] rounded-[1px] bg-white/90" />
          <span className="mt-[4%] block h-[14%] w-[40%] rounded-[1px] bg-white/90" />
          <span className="mt-[8%] block h-[12%] w-[22%] rounded-[1px] bg-(--hz-blue)" />
        </span>
        <span className="grid flex-1 grid-cols-3 gap-[4%] p-[6%]">
          <span className="border border-black/10 bg-white" />
          <span className="border border-black/10 bg-white" />
          <span className="border border-black/10 bg-white" />
        </span>
      </span>
    );
  }
  if (template === "orbit") {
    return (
      <span
        aria-hidden="true"
        className={cn(frame, "landing-orbit-palette flex flex-col bg-(--ob-sky) p-[2%]")}
      >
        <span className="relative h-[60%] overflow-hidden rounded-[10px] bg-[radial-gradient(120%_90%_at_78%_8%,var(--ob-violet-649),var(--ob-indigo-818)_68%,var(--ob-indigo-869))] px-[6%] pt-[4%]">
          <span className="block h-[15%] w-full rounded-[4px] border border-white/15" />
          <span className="mt-[9%] block h-[11%] w-[46%] rounded-sm bg-white/90" />
          <span className="mt-[4%] block h-[11%] w-[34%] rounded-sm bg-white/90" />
          <span className="mt-[7%] block h-[12%] w-[22%] rounded-[2px] bg-[linear-gradient(85deg,var(--ob-rose-345)_-70%,var(--ob-amber-359))]" />
          <span className="absolute right-[9%] bottom-[14%] aspect-square h-[58%] rounded-full bg-[radial-gradient(circle_at_32%_26%,var(--ob-violet-282),var(--ob-indigo-686)_78%)]" />
          <span className="absolute right-[4%] bottom-[34%] h-[3%] w-[42%] -rotate-12 rounded-full bg-(--ob-violet-173)/60" />
        </span>
        <span className="grid flex-1 grid-cols-3 gap-[4%] p-[5%]">
          <span className="rounded-sm bg-white shadow-sm" />
          <span className="rounded-sm bg-white shadow-sm" />
          <span className="rounded-sm bg-white shadow-sm" />
        </span>
      </span>
    );
  }
  return (
    <span aria-hidden="true" className={cn(frame, "flex bg-muted")}>
      <span className="w-[24%] border-r border-foreground/10 bg-background/60 p-[4%]">
        <span className="block h-[6%] w-[70%] rounded-full bg-foreground/15" />
        <span className="mt-[18%] block h-[5%] w-[80%] rounded-full bg-foreground/10" />
        <span className="mt-[10%] block h-[5%] w-[60%] rounded-full bg-foreground/10" />
      </span>
      <span className="grid flex-1 grid-cols-3 content-start gap-[5%] p-[6%]">
        <span className="h-8 rounded-md bg-background/80" />
        <span className="h-8 rounded-md bg-background/80" />
        <span className="h-8 rounded-md bg-background/80" />
      </span>
    </span>
  );
}
