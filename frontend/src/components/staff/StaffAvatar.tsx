import { useEffect, useState } from 'react';
import { fetchHqStaffPhoto, fetchMyStaffPhoto } from '../../lib/api';

type Source = 'hq' | 'self';

/** 以「來源:員工:版本」快取頭像，版本（photoUpdatedAt）變更即重抓 */
const cache = new Map<string, Promise<string | null>>();

function loadAvatar(source: Source, staffId: number, version: string): Promise<string | null> {
  const key = `${source}:${staffId}:${version}`;
  let hit = cache.get(key);
  if (!hit) {
    const req = source === 'self' ? fetchMyStaffPhoto() : fetchHqStaffPhoto(staffId);
    hit = req.then((r) => r.data?.dataUrl ?? null).catch(() => {
      cache.delete(key);
      return null;
    });
    cache.set(key, hit);
  }
  return hit;
}

type Props = {
  staffId: number;
  name?: string | null;
  /** photoUpdatedAt；null／undefined 表示無照片，直接顯示姓名首字 */
  version?: string | null;
  source?: Source;
  size?: 'sm' | 'md' | 'lg';
  /** 直接指定影像（上傳前預覽） */
  src?: string | null;
};

export default function StaffAvatar({ staffId, name, version, source = 'hq', size = 'sm', src }: Props) {
  const [loaded, setLoaded] = useState<{ key: string; url: string | null } | null>(null);
  const key = version ? `${source}:${staffId}:${version}` : '';

  useEffect(() => {
    if (!key || src) return;
    let alive = true;
    void loadAvatar(source, staffId, version as string).then((url) => {
      if (alive) setLoaded({ key, url });
    });
    return () => {
      alive = false;
    };
  }, [key, source, staffId, version, src]);

  const url = src ?? (loaded?.key === key ? loaded.url : null);
  const sizeClass = size === 'md' ? '' : ` avatar--${size}`;
  return (
    <div className={`avatar${sizeClass}${url ? ' avatar--photo' : ''}`} aria-label={name || '員工'}>
      {url ? <img src={url} alt="" draggable={false} /> : (name?.trim().charAt(0) || '?')}
    </div>
  );
}
