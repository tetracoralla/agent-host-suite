import React, { useEffect, useRef, useState } from 'react'

export function DebouncedInput({ value, onCommit, multiline = false, onBlur, ...props }) {
  const [local, setLocal] = useState(value ?? '')
  const lastCommitted = useRef(value ?? '')

  useEffect(() => {
    if (value !== lastCommitted.current) {
      lastCommitted.current = value ?? ''
      setLocal(value ?? '')
    }
  }, [value])

  useEffect(() => {
    if (local === lastCommitted.current) return undefined
    const timer = setTimeout(() => {
      lastCommitted.current = local
      onCommit(local)
    }, 360)
    return () => clearTimeout(timer)
  }, [local, onCommit])

  const flush = () => {
    if (local === lastCommitted.current) return
    lastCommitted.current = local
    onCommit(local)
  }
  const Component = multiline ? 'textarea' : 'input'
  return <Component
    {...props}
    value={local}
    onChange={(event) => setLocal(event.target.value)}
    onBlur={(event) => { flush(); onBlur?.(event) }}
    onKeyDown={(event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') flush()
      props.onKeyDown?.(event)
    }}
  />
}

export function Field({ label, hint, children }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>
}

export function TagList({ values, empty = 'None' }) {
  if (!values?.length) return <span className="muted">{empty}</span>
  return <div className="tag-list">{values.map((value) => <span key={value}>{value}</span>)}</div>
}
