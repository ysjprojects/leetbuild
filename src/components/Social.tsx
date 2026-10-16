import {type ChangeEvent, type FC, memo, useCallback, useEffect, useMemo, useRef, useState} from 'react';

import {drawCertificate} from '@/lib/certificate';
import {
  type CertificateDetails,
  courseShareText,
  linkedInAddCertificateUrl,
  linkedInPostUrl,
  openShare,
} from '@/lib/social';

/**
 * Sharing surfaces: the LinkedIn button (opens LinkedIn's composer or "Add to profile" in a popup;
 * nothing is posted without the learner) and the certificate dialog's body — a name field with a
 * live preview drawn by the same code that produces the download.
 *
 * The logo follows brand.linkedin.com/in-logo, which allows the [in] mark as a Share button in
 * blue, black or white only, unaltered: quiet buttons and icons use the bug (the rounded square with
 * the letters cut out) in `--lb-linkedin` (white on Night, LinkedIn blue on Day); solid buttons are
 * drawn the way LinkedIn draws its own Share and Add-to-profile buttons — LinkedIn blue, the white
 * letters in a divided cell on the left, a bold white label.
 */

const LETTERS =
  'M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452z';
const SQUARE =
  'M22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z';

/** The [in] bug: the letters knocked out of the rounded square. Coloured by `--lb-linkedin` unless told otherwise. */
export const LinkedInBug: FC<{size?: number; className?: string}> = memo(
  ({size = 14, className = 'text-[color:var(--lb-linkedin)]'}) => (
    <svg aria-hidden className={className} fill="currentColor" height={size} viewBox="0 0 24 24" width={size}>
      <path d={`${LETTERS}${SQUARE}`} />
    </svg>
  ),
);
LinkedInBug.displayName = 'LinkedInBug';

/** The bare letters, as they sit on LinkedIn's own blue buttons. */
const LinkedInLetters: FC<{size: number}> = memo(({size}) => (
  <svg aria-hidden fill="currentColor" height={size} viewBox="3 3 18 18" width={size}>
    <path d={LETTERS} />
  </svg>
));
LinkedInLetters.displayName = 'LinkedInLetters';

/**
 * `solid`: a primary action in LinkedIn's own button style. `quiet`: a contextual share — a ghost
 * button with the bug, a label and a border on hover. `icon`: the bug alone for dense rows; the label
 * becomes the accessible name and the tooltip.
 */
type Tone = 'solid' | 'quiet' | 'icon';

/** Tooltip for composer links: what happens on click, and that nothing is posted by itself. */
export const POST_HINT =
  'opens LinkedIn in a new window with a draft you can edit; nothing is posted until you press Post';

/** Opens `url` (a LinkedIn composer or add-to-profile link) in a popup. */
export const LinkedInButton: FC<{url: string; label: string; title?: string; tone?: Tone}> = memo(
  ({url, label, title, tone = 'quiet'}) => {
    const onClick = useCallback(() => openShare(url), [url]);
    if (tone === 'solid')
      return (
        <button
          className="inline-flex h-8 shrink-0 items-stretch overflow-hidden rounded bg-[#0a66c2] text-[12px] font-bold text-white transition hover:bg-[#004182]"
          onClick={onClick}
          title={title ?? label}
          type="button">
          <span className="flex items-center border-r border-white/30 px-2">
            <LinkedInLetters size={15} />
          </span>
          <span className="flex items-center px-2.5">{label}</span>
        </button>
      );
    if (tone === 'icon')
      return (
        <button
          aria-label={label}
          className="hover:bg-ink-800 flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition"
          onClick={onClick}
          title={title ?? label}
          type="button">
          <LinkedInBug size={15} />
        </button>
      );
    return (
      <button
        className="text-ink-200 hover:border-ink-600 hover:bg-ink-800 hover:text-ink-50 inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-transparent px-2 text-[11px] font-semibold transition"
        onClick={onClick}
        title={title ?? label}
        type="button">
        <LinkedInBug />
        {label}
      </button>
    );
  },
);
LinkedInButton.displayName = 'LinkedInButton';

/** Tooltip for the add-to-profile link. */
export const PROFILE_HINT =
  "opens LinkedIn's Licenses & certifications form in a new window, prefilled with this certificate";

/** The certificate as it will be downloaded, redrawn as the name changes. */
const CertificatePreview: FC<{details: CertificateDetails; url: string}> = memo(({details, url}) => {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current !== null) drawCertificate(ref.current, details, url);
  }, [details, url]);
  return <canvas aria-label="certificate preview" className="border-ink-600 w-full rounded-lg border" ref={ref} />;
});
CertificatePreview.displayName = 'CertificatePreview';

/**
 * Body of the certificate dialog. `onName` reports every edit so the dialog's confirm action
 * downloads the certificate with the name as typed; `verifyUrl` builds the address for the preview.
 */
export const CertificateForm: FC<{
  details: CertificateDetails;
  verifyUrl: (details: CertificateDetails) => string;
  onName: (name: string) => void;
}> = memo(({details, verifyUrl, onName}) => {
  const [name, setName] = useState(details.name);
  const onChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      setName(e.target.value);
      onName(e.target.value);
    },
    [onName],
  );
  const current = useMemo(() => ({...details, name: name.trim() === '' ? 'Your name' : name.trim()}), [details, name]);
  return (
    <div className="space-y-3">
      <label className="block">
        <span className="text-ink-200 block text-[12px] font-semibold">Name on the certificate</span>
        <input
          autoFocus
          className="border-ink-600 bg-ink-900 text-ink-50 focus:border-iris-400 mt-1 w-full rounded-lg border px-3 py-1.5 text-[13px] focus:outline-none focus:ring-0"
          maxLength={80}
          onChange={onChange}
          placeholder="Your name"
          spellCheck={false}
          type="text"
          value={name}
        />
      </label>
      <CertificatePreview details={current} url={verifyUrl(current)} />
      <div className="flex flex-wrap items-center gap-2">
        <LinkedInButton
          label="Add to LinkedIn profile"
          title={PROFILE_HINT}
          tone="solid"
          url={linkedInAddCertificateUrl(current, verifyUrl(current))}
        />
        <LinkedInButton
          label="Share on LinkedIn"
          title={POST_HINT}
          tone="solid"
          url={linkedInPostUrl(courseShareText(current, verifyUrl(current)))}
        />
      </div>
      <p className="text-ink-400 text-[11px]">
        “Download” saves a PNG (A4 landscape) with the course, date, score and a certificate id. “Add to LinkedIn
        profile” files it under Licenses &amp; certifications with a link back to its page here; “Share” opens a post
        you can edit before publishing.
      </p>
    </div>
  );
});
CertificateForm.displayName = 'CertificateForm';
