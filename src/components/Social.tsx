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
 */

export const LinkedInIcon: FC<{size?: number}> = memo(({size = 13}) => (
  <svg aria-hidden fill="currentColor" height={size} viewBox="0 0 16 16" width={size}>
    <path d="M3.6 2a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2ZM2.2 6.2h2.8V14H2.2V6.2Zm4.6 0h2.7v1.1c.4-.7 1.3-1.3 2.6-1.3 2.8 0 3.3 1.8 3.3 4.2V14h-2.8v-3.4c0-.8 0-1.9-1.2-1.9s-1.3.9-1.3 1.8V14H6.8V6.2Z" />
  </svg>
));
LinkedInIcon.displayName = 'LinkedInIcon';

type Tone = 'quiet' | 'solid';

const TONES: Record<Tone, string> = {
  quiet: 'text-ink-300 hover:text-ink-50 hover:bg-ink-800 rounded-md px-1.5 py-0.5 text-[11px]',
  solid: 'bg-[#0a66c2] text-white hover:bg-[#0b5cad] rounded-lg px-3 py-1.5 text-[12px] font-semibold',
};

/** Opens `url` (a LinkedIn composer or add-to-profile link) in a popup. */
export const LinkedInButton: FC<{url: string; label: string; title?: string; tone?: Tone}> = memo(
  ({url, label, title, tone = 'quiet'}) => {
    const onClick = useCallback(() => openShare(url), [url]);
    return (
      <button
        className={`flex items-center gap-1.5 transition ${TONES[tone]}`}
        onClick={onClick}
        title={title ?? label}
        type="button">
        <LinkedInIcon size={tone === 'solid' ? 14 : 12} />
        {label}
      </button>
    );
  },
);
LinkedInButton.displayName = 'LinkedInButton';

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
          tone="solid"
          url={linkedInAddCertificateUrl(current, verifyUrl(current))}
        />
        <LinkedInButton
          label="Share on LinkedIn"
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
