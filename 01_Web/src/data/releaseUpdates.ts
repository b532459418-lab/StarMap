import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
// Only `version`: a named JSON import lets the bundler drop the rest of package.json (scripts, dependencies) from the
// public bundle, so editing npm scripts no longer changes the bundle hash (batch 5A P6).
import { version as packageVersion } from '../../package.json'
import { copyUpdateText, readUpdateStorage, writeUpdateStorage } from './releaseUpdateStorage.ts'

export type GitHubRelease = {
  body: string | null
  html_url: string
  name: string | null
  published_at: string
  tag_name: string
}

type UpdateStatus = 'idle' | 'checking' | 'current' | 'available' | 'unconfigured' | 'error'
type CopyResult = 'idle' | 'copied' | 'failed'

type UpdateCache = {
  checkedAt: number
  release: GitHubRelease | null
}

const repository = import.meta.env.VITE_GITHUB_REPOSITORY?.trim() || 'b532459418-lab/StarMap'
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const repositoryConfigured = repositoryPattern.test(repository)
const currentVersion = packageVersion
const checkIntervalMs = 12 * 60 * 60 * 1000

const numericVersion = (version: string) => {
  const match = version.trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/)
  return match ? match.slice(1).map(Number) : undefined
}

const isNewerVersion = (candidate: string, current: string) => {
  const candidateParts = numericVersion(candidate)
  const currentParts = numericVersion(current)

  if (!candidateParts || !currentParts) {
    return candidate.trim().replace(/^v/i, '') !== current.trim().replace(/^v/i, '')
  }

  for (let index = 0; index < candidateParts.length; index += 1) {
    if (candidateParts[index] > currentParts[index]) return true
    if (candidateParts[index] < currentParts[index]) return false
  }

  return false
}

export function useReleaseUpdates() {
  const { t } = useTranslation('appShell')
  const [status, setStatus] = useState<UpdateStatus>(repositoryConfigured ? 'idle' : 'unconfigured')
  const [release, setRelease] = useState<GitHubRelease>()
  const [copyResult, setCopyResult] = useState<CopyResult>('idle')
  const [messageKey, setMessageKey] = useState('')
  const [hasUnseenUpdate, setHasUnseenUpdate] = useState(false)

  const checkForUpdates = useCallback(async (force = false) => {
    if (!repositoryConfigured) {
      setStatus('unconfigured')
      setMessageKey('noRepository')
      return
    }

    const cacheKey = `travel-atlas:update:${repository}`
    const dismissedKey = `${cacheKey}:dismissed`

    const applyRelease = (latestRelease: GitHubRelease | null) => {
      if (!latestRelease) {
        setRelease(undefined)
        setStatus('current')
        setMessageKey('noRelease')
        setHasUnseenUpdate(false)
        return
      }

      const available = isNewerVersion(latestRelease.tag_name, currentVersion)
      setRelease(latestRelease)
      setStatus(available ? 'available' : 'current')
      setMessageKey('')
      setHasUnseenUpdate(
        available && readUpdateStorage(dismissedKey) !== latestRelease.tag_name,
      )
    }

    try {
      if (!force) {
        const cachedValue = readUpdateStorage(cacheKey)
        if (cachedValue) {
          const cached = JSON.parse(cachedValue) as UpdateCache
          if (Date.now() - cached.checkedAt < checkIntervalMs) {
            applyRelease(cached.release)
            return
          }
        }
      }

      setStatus('checking')
      setMessageKey('')
      const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json' },
      })

      if (response.status === 404) {
        writeUpdateStorage(cacheKey, JSON.stringify({
          checkedAt: Date.now(),
          release: null,
        } satisfies UpdateCache))
        applyRelease(null)
        return
      }
      if (!response.ok) throw new Error(`GitHub release request failed: ${response.status}`)

      const latestRelease = await response.json() as GitHubRelease
      writeUpdateStorage(cacheKey, JSON.stringify({
        checkedAt: Date.now(),
        release: latestRelease,
      } satisfies UpdateCache))
      applyRelease(latestRelease)
    } catch {
      setStatus('error')
      setMessageKey('connectionFailed')
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void checkForUpdates(false)
    }, 0)

    return () => window.clearTimeout(timer)
  }, [checkForUpdates])

  const markSeen = () => {
    setHasUnseenUpdate(false)
    if (release && status === 'available') {
      writeUpdateStorage(`travel-atlas:update:${repository}:dismissed`, release.tag_name)
    }
  }

  const copyUpdatePrompt = async () => {
    if (!release) return
    const copied = await copyUpdateText(t('updatePrompt', { version: release.tag_name, url: release.html_url }))
    setCopyResult(copied ? 'copied' : 'failed')
    window.setTimeout(() => setCopyResult('idle'), 1800)
  }

  return {
    checkForUpdates,
    copied: copyResult === 'copied',
    copyFailed: copyResult === 'failed',
    copyUpdatePrompt,
    currentVersion,
    hasUnseenUpdate,
    markSeen,
    message: messageKey ? t(messageKey) : '',
    release,
    repositoryConfigured,
    status,
  }
}

export type ReleaseUpdateState = ReturnType<typeof useReleaseUpdates>
