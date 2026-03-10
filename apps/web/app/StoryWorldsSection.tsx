'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';

import { THEME_PREVIEW_DURATION_SEC, resolveThemePreviewClip } from './lib/theme-preview-clips';

export type StoryWorld = {
  name: string;
  tone: string;
  description: string;
  accent: string;
  ambience: string;
  sceneArc: [string, string, string];
  palette: [string, string];
};

type StoryWorldsSectionProps = {
  worlds: StoryWorld[];
};

const AUTO_ROTATE_MS = 5600;

export function StoryWorldsSection({ worlds }: StoryWorldsSectionProps): JSX.Element {
  const sectionRef = useRef<HTMLElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [activeWorldIndex, setActiveWorldIndex] = useState(0);
  const [isInView, setIsInView] = useState(false);
  const [isImmersed, setIsImmersed] = useState(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const [videoUnavailable, setVideoUnavailable] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updatePreference = (): void => setPrefersReducedMotion(mediaQuery.matches);
    updatePreference();

    mediaQuery.addEventListener('change', updatePreference);
    return () => mediaQuery.removeEventListener('change', updatePreference);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const updateFromHash = (): void => {
      if (window.location.hash === '#worlds') {
        setIsImmersed(true);
      }
    };

    updateFromHash();
    window.addEventListener('hashchange', updateFromHash);
    return () => window.removeEventListener('hashchange', updateFromHash);
  }, []);

  useEffect(() => {
    const node = sectionRef.current;
    if (!node) {
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        const sectionVisible = entry.isIntersecting;
        setIsInView(sectionVisible);

        if (sectionVisible) {
          setIsImmersed(true);
        }
      },
      { threshold: 0.45 }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isInView || prefersReducedMotion || worlds.length < 2) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setActiveWorldIndex((current) => (current + 1) % worlds.length);
    }, AUTO_ROTATE_MS);

    return () => window.clearInterval(intervalId);
  }, [isInView, prefersReducedMotion, worlds.length]);

  const activeWorld = worlds[activeWorldIndex] ?? worlds[0];
  const activeThemeClip = resolveThemePreviewClip(activeWorld?.name ?? '');

  if (!activeWorld) {
    return (
      <section className="worlds-section" id="worlds">
        <div className="section-heading">
          <span className="section-kicker">Story Worlds</span>
          <h2>World previews are loading.</h2>
        </div>
      </section>
    );
  }

  const stageStyle = {
    '--world-primary': activeWorld.palette[0],
    '--world-secondary': activeWorld.palette[1]
  } as CSSProperties;
  const progressStyle = {
    gridTemplateColumns: `repeat(${worlds.length}, minmax(0, 1fr))`
  } as CSSProperties;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !activeWorld) {
      return;
    }

    setVideoUnavailable(false);
    video.load();

    const restartPreview = (): void => {
      video.currentTime = activeThemeClip.startSec;
      video.playbackRate = 1.14;

      if (prefersReducedMotion) {
        video.pause();
        return;
      }

      void video.play().catch(() => {
        // Ignore autoplay rejection and let manual replay handle interaction cases.
      });
    };

    if (video.readyState >= 1) {
      restartPreview();
      return;
    }

    const onLoadedMetadata = (): void => restartPreview();
    video.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });
    return () => video.removeEventListener('loadedmetadata', onLoadedMetadata);
  }, [activeWorld, activeThemeClip.src, activeThemeClip.startSec, prefersReducedMotion]);

  function handleVideoTimeUpdate(): void {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    const endTime = activeThemeClip.startSec + THEME_PREVIEW_DURATION_SEC;
    if (video.currentTime >= endTime) {
      video.currentTime = activeThemeClip.startSec;
      if (!prefersReducedMotion) {
        void video.play().catch(() => undefined);
      }
    }
  }

  function replayThemeCut(): void {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    video.currentTime = activeThemeClip.startSec;
    if (!prefersReducedMotion) {
      void video.play().catch(() => undefined);
    }
  }

  return (
    <section className={`worlds-section immersive-worlds ${isImmersed ? 'immersive-worlds-live' : ''}`} id="worlds" ref={sectionRef}>
      <div className="section-heading">
        <span className="section-kicker">Story Worlds</span>
        <h2>Designed like miniature films, then staged in motion.</h2>
        <p>
          Enter a world and watch the scene language shift in real time. Tone, atmosphere, and narrative beats are
          orchestrated together so this feels like a studio slate, not static cards.
        </p>
      </div>

      <div className="worlds-immersive-grid">
        <article className={`world-stage ${isInView ? 'world-stage-awake' : ''}`} style={stageStyle} aria-live="polite">
          <div className="world-stage-video-shell">
            <video
              ref={videoRef}
              key={`${activeWorld.name}-${activeThemeClip.src}`}
              className="world-stage-video"
              muted
              playsInline
              preload="metadata"
              onTimeUpdate={handleVideoTimeUpdate}
              onError={() => setVideoUnavailable(true)}
            >
              <source src={activeThemeClip.src} type="video/mp4" />
            </video>
            <div className="world-stage-video-vignette" aria-hidden="true" />
            {videoUnavailable ? <span className="world-stage-video-fallback">Video preview unavailable.</span> : null}
          </div>
          <div className="world-stage-film-grain" aria-hidden="true" />
          <span className="world-stage-light world-stage-light-a" aria-hidden="true" />
          <span className="world-stage-light world-stage-light-b" aria-hidden="true" />
          <span className="world-stage-light world-stage-light-c" aria-hidden="true" />
          <div className="world-stage-copy">
            <span className="world-stage-kicker">3s Theme Cut</span>
            <h3>{activeWorld.name}</h3>
            <p className="world-stage-tone">{activeWorld.tone}</p>
            <p>{activeWorld.description}</p>
            <div className="world-stage-tags">
              <span>{activeWorld.accent}</span>
              <span>{activeWorld.ambience}</span>
            </div>
            <button type="button" className="world-stage-replay" onClick={replayThemeCut}>
              Replay 3s Cut
            </button>
            <ol className="world-stage-arc">
              {activeWorld.sceneArc.map((beat, index) => (
                <li key={beat}>
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <p>{beat}</p>
                </li>
              ))}
            </ol>
          </div>
          <div className="world-stage-progress" aria-hidden="true" style={progressStyle}>
            {worlds.map((world, index) => {
              const stateClass = index === activeWorldIndex ? 'is-current' : index < activeWorldIndex ? 'is-seen' : '';
              return <span key={world.name} className={stateClass} />;
            })}
          </div>
        </article>

        <div className="world-nav-rail">
          {worlds.map((world, index) => {
            const cardStyle = {
              '--card-primary': world.palette[0],
              '--card-secondary': world.palette[1]
            } as CSSProperties;

            return (
              <button
                key={world.name}
                type="button"
                className={`world-nav-card ${index === activeWorldIndex ? 'is-active' : ''}`}
                onMouseEnter={() => setActiveWorldIndex(index)}
                onFocus={() => setActiveWorldIndex(index)}
                onClick={() => {
                  setActiveWorldIndex(index);
                  setIsImmersed(true);
                }}
                style={cardStyle}
                aria-pressed={index === activeWorldIndex}
                aria-label={`Preview ${world.name}`}
              >
                <span className="world-card-chip world-card-chip-soft">{world.tone}</span>
                <h3>{world.name}</h3>
                <p>{world.description}</p>
                <span className="world-nav-note">{world.accent}</span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
