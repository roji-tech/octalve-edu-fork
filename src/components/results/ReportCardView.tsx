"use client";

import React from "react";

export interface ReportCardSubject {
  subjectName: string;
  subjectCode?: string | null;
  score: number;
  maxScore: number;
  gradeLetter?: string | null;
  gradeRemark?: string | null;
}

export interface ReportCardProps {
  institutionName: string;
  student: {
    admissionNo: string;
    firstName: string;
    lastName: string;
    classGroup?: string;
    classArm?: string;
  };
  period: {
    label: string;
    sessionLabel: string;
  };
  summary: {
    totalScore: number;
    totalMax: number;
    percentage: number;
    classRank?: number | null;
    classSize?: number;
    promotionOutcome: "PROMOTED" | "REPEATED";
  };
  subjects: ReportCardSubject[];
  verificationToken?: string | null;
  verificationHash?: string | null;
}

export function ReportCardView({
  institutionName,
  student,
  period,
  summary,
  subjects,
  verificationToken,
  verificationHash,
}: ReportCardProps) {
  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Print Trigger */}
      <div className="flex justify-end print:hidden">
        <button
          type="button"
          onClick={handlePrint}
          className="min-h-11 px-5 py-2.5 rounded-lg text-sm font-semibold bg-gray-900 hover:bg-gray-800 text-white dark:bg-gray-100 dark:hover:bg-gray-200 dark:text-gray-900 transition shadow-sm"
        >
          Print / Save PDF
        </button>
      </div>

      {/* Main Report Card Card */}
      <div className="p-8 rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-md space-y-8 print:shadow-none print:border-none print:p-0">
        {/* Institutional Header */}
        <div className="text-center space-y-2 border-b border-gray-200 dark:border-gray-800 pb-6">
          <h1 className="text-2xl font-black tracking-tight text-gray-900 dark:text-gray-100 uppercase">{institutionName}</h1>
          <p className="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-widest">
            Official Term Assessment & Progress Report
          </p>
          <div className="inline-block px-3 py-1 rounded-full text-xs font-semibold bg-indigo-50 dark:bg-indigo-950/50 text-indigo-700 dark:text-indigo-300">
            {period.sessionLabel} Academic Session — {period.label}
          </div>
        </div>

        {/* Student Meta Details */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 p-4 rounded-xl bg-gray-50 dark:bg-gray-800/40 text-sm">
          <div>
            <span className="block text-xs text-gray-400">Student Name</span>
            <span className="font-bold text-gray-900 dark:text-gray-100">
              {student.firstName} {student.lastName}
            </span>
          </div>
          <div>
            <span className="block text-xs text-gray-400">Admission No</span>
            <span className="font-mono font-bold text-gray-900 dark:text-gray-100">{student.admissionNo}</span>
          </div>
          <div>
            <span className="block text-xs text-gray-400">Class & Arm</span>
            <span className="font-bold text-gray-900 dark:text-gray-100">
              {student.classGroup ?? "—"} ({student.classArm ?? "—"})
            </span>
          </div>
          <div>
            <span className="block text-xs text-gray-400">Class Position</span>
            <span className="font-bold text-indigo-600 dark:text-indigo-400">
              {summary.classRank ? `${summary.classRank} of ${summary.classSize ?? "—"}` : "—"}
            </span>
          </div>
        </div>

        {/* Performance Metrics Summary Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="p-4 rounded-xl border border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-800 text-center">
            <span className="text-xs text-gray-400 uppercase font-semibold">Total Score</span>
            <div className="text-2xl font-black text-gray-900 dark:text-gray-100 mt-1">
              {summary.totalScore} <span className="text-sm font-normal text-gray-400">/ {summary.totalMax}</span>
            </div>
          </div>
          <div className="p-4 rounded-xl border border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-800 text-center">
            <span className="text-xs text-gray-400 uppercase font-semibold">Cumulative Average</span>
            <div className="text-2xl font-black text-indigo-600 dark:text-indigo-400 mt-1">{summary.percentage}%</div>
          </div>
          <div className="p-4 rounded-xl border border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-800 text-center">
            <span className="text-xs text-gray-400 uppercase font-semibold">Promotion Outcome</span>
            <div
              className={`text-2xl font-black mt-1 ${
                summary.promotionOutcome === "PROMOTED" ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"
              }`}
            >
              {summary.promotionOutcome}
            </div>
          </div>
        </div>

        {/* Subject Scores Table */}
        <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-800">
          <table className="w-full text-left border-collapse text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 text-xs font-semibold uppercase text-gray-500 dark:text-gray-400">
                <th className="py-3 px-4">Subject</th>
                <th className="py-3 px-4 text-center">Score / Max</th>
                <th className="py-3 px-4 text-center">Grade</th>
                <th className="py-3 px-4">Teacher Remark</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {subjects.map((s, idx) => (
                <tr key={idx} className="hover:bg-gray-50/50 dark:hover:bg-gray-800/30">
                  <td className="py-3.5 px-4 font-semibold text-gray-900 dark:text-gray-100">
                    {s.subjectName}
                    {s.subjectCode && <span className="ml-2 font-mono text-xs text-gray-400">({s.subjectCode})</span>}
                  </td>
                  <td className="py-3.5 px-4 text-center font-bold text-gray-900 dark:text-gray-100">
                    {s.score} / {s.maxScore}
                  </td>
                  <td className="py-3.5 px-4 text-center">
                    <span className="inline-block px-2.5 py-0.5 rounded text-xs font-bold bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300">
                      {s.gradeLetter ?? "—"}
                    </span>
                  </td>
                  <td className="py-3.5 px-4 text-gray-600 dark:text-gray-300 text-xs italic">{s.gradeRemark ?? "Satisfactory"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Tamper-Evident Verification Footer Badge */}
        {verificationToken && (
          <div className="p-4 rounded-xl border border-dashed border-gray-300 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-800/30 flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="space-y-1 text-center sm:text-left">
              <div className="flex items-center justify-center sm:justify-start gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
                <span className="text-xs font-bold uppercase tracking-wider text-gray-700 dark:text-gray-300">
                  Tamper-Evident Digitally Verified
                </span>
              </div>
              <p className="text-xs text-gray-500 font-mono">Verification Token: {verificationToken}</p>
              {verificationHash && (
                <p className="text-[10px] text-gray-400 font-mono break-all max-w-md">SHA-256 Digest: {verificationHash}</p>
              )}
            </div>

            <div className="text-center sm:text-right">
              <span className="text-xs text-gray-500 block">Public Verify URL:</span>
              <span className="text-xs font-mono font-semibold text-indigo-600 dark:text-indigo-400">
                /api/v1/verify/{verificationToken}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
