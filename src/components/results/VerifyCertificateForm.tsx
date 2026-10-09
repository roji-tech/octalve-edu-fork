"use client";

import React, { useState } from "react";

export interface VerificationResult {
  verified: boolean;
  institution: string;
  studentAdmissionNo: string;
  studentInitials: string;
  academicSession: string;
  academicPeriod: string;
  subject: string;
  gradeLetter?: string | null;
  publishedAt?: string | null;
  verificationHash?: string | null;
}

export function VerifyCertificateForm() {
  const [tokenInput, setTokenInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<VerificationResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    const token = tokenInput.trim();
    if (!token) return;

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch(`/api/v1/verify/${encodeURIComponent(token)}`);
      const body = await res.json();

      if (!res.ok || !body.data) {
        setError(body.error?.message ?? "Academic credential could not be verified. Ensure token is valid and published.");
      } else {
        setResult(body.data as VerificationResult);
      }
    } catch {
      setError("Network or server error while validating credential. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      {/* Search / Token Input Form */}
      <div className="p-8 rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-md space-y-6">
        <div className="text-center space-y-2">
          <div className="w-12 h-12 mx-auto rounded-full bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 flex items-center justify-center font-black text-xl">
            ✓
          </div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Verify Academic Credential</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Enter the 32-character digital verification token located on the official report card or certificate.
          </p>
        </div>

        <form onSubmit={handleVerify} className="space-y-4">
          <div>
            <label htmlFor="token" className="block text-xs font-semibold uppercase text-gray-600 dark:text-gray-400 mb-1.5">
              Verification Token
            </label>
            <input
              id="token"
              type="text"
              required
              maxLength={32}
              placeholder="e.g. 4a2b9c8d1e3f5a7b6c8d9e0f1a2b3c4d"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              className="w-full min-h-11 px-4 py-2 font-mono text-sm rounded-xl border border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          <button
            type="submit"
            disabled={loading || !tokenInput.trim()}
            className="w-full min-h-11 py-3 px-6 rounded-xl font-semibold text-white bg-indigo-600 hover:bg-indigo-700 transition disabled:opacity-50 shadow-sm"
          >
            {loading ? "Validating Cryptographic Credential..." : "Verify Credential"}
          </button>
        </form>

        {error && (
          <div className="p-4 rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-300 text-sm flex items-start gap-3">
            <span className="font-bold">✕</span>
            <span>{error}</span>
          </div>
        )}
      </div>

      {/* Verified Authentic Badge View */}
      {result && (
        <div className="p-8 rounded-2xl border-2 border-emerald-500 dark:border-emerald-600 bg-white dark:bg-gray-900 shadow-xl space-y-6">
          <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-800 pb-4">
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-xs font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
                Verified Authentic Academic Credential
              </span>
            </div>
            {result.publishedAt && (
              <span className="text-xs text-gray-400">Published {new Date(result.publishedAt).toLocaleDateString()}</span>
            )}
          </div>

          <div className="space-y-4 text-sm">
            <div>
              <span className="block text-xs text-gray-400 uppercase">Issuing School</span>
              <span className="text-lg font-bold text-gray-900 dark:text-gray-100">{result.institution}</span>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <span className="block text-xs text-gray-400 uppercase">Student Initials</span>
                <span className="font-semibold text-gray-800 dark:text-gray-200">{result.studentInitials}</span>
              </div>
              <div>
                <span className="block text-xs text-gray-400 uppercase">Admission Number</span>
                <span className="font-mono font-semibold text-gray-800 dark:text-gray-200">{result.studentAdmissionNo}</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <span className="block text-xs text-gray-400 uppercase">Session & Period</span>
                <span className="font-semibold text-gray-800 dark:text-gray-200">
                  {result.academicSession} — {result.academicPeriod}
                </span>
              </div>
              <div>
                <span className="block text-xs text-gray-400 uppercase">Subject & Grade</span>
                <span className="font-semibold text-gray-800 dark:text-gray-200">
                  {result.subject} ({result.gradeLetter ?? "—"})
                </span>
              </div>
            </div>

            {result.verificationHash && (
              <div className="pt-2 border-t border-gray-100 dark:border-gray-800">
                <span className="block text-[11px] text-gray-400 uppercase font-mono">Cryptographic SHA-256 Digest</span>
                <span className="font-mono text-xs text-gray-600 dark:text-gray-400 break-all">{result.verificationHash}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
