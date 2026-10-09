"use client";

import React, { useState } from "react";
import { ResultStatus } from "@prisma/client";

export interface ApprovalItem {
  id: string;
  studentName: string;
  admissionNo: string;
  subjectName: string;
  score: number;
  maxScore: number;
  gradeLetter?: string | null;
  status: ResultStatus;
}

interface ResultsApprovalConsoleProps {
  items: ApprovalItem[];
  onTransition: (resultIds: string[], toStatus: ResultStatus, reason?: string) => Promise<void>;
  isAdmin?: boolean;
}

export function ResultsApprovalConsole({ items, onTransition, isAdmin = false }: ResultsApprovalConsoleProps) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [filter, setFilter] = useState<ResultStatus | "ALL">("ALL");
  const [isProcessing, setIsProcessing] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [showRejectDialog, setShowRejectDialog] = useState(false);

  const filteredItems = items.filter((item) => {
    if (filter === "ALL") return true;
    return item.status === filter;
  });

  const handleSelectAll = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.checked) {
      setSelectedIds(filteredItems.map((i) => i.id));
    } else {
      setSelectedIds([]);
    }
  };

  const handleToggleSelect = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  };

  const handleAction = async (toStatus: ResultStatus, reason?: string) => {
    if (selectedIds.length === 0) return;
    setIsProcessing(true);
    try {
      await onTransition(selectedIds, toStatus, reason);
      setSelectedIds([]);
      setShowRejectDialog(false);
      setRejectReason("");
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Action Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm">
        <div>
          <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">Results Review & Publishing Console</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {selectedIds.length} of {filteredItems.length} records selected
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => handleAction(ResultStatus.APPROVED)}
            disabled={selectedIds.length === 0 || isProcessing}
            className="min-h-11 px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white transition disabled:opacity-50"
          >
            Approve Selected
          </button>
          <button
            type="button"
            onClick={() => handleAction(ResultStatus.PUBLISHED)}
            disabled={selectedIds.length === 0 || isProcessing}
            className="min-h-11 px-4 py-2 rounded-lg text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white transition disabled:opacity-50"
          >
            Publish to Portal
          </button>
          <button
            type="button"
            onClick={() => setShowRejectDialog(true)}
            disabled={selectedIds.length === 0 || isProcessing}
            className="min-h-11 px-4 py-2 rounded-lg text-sm font-medium bg-red-600 hover:bg-red-700 text-white transition disabled:opacity-50"
          >
            Reject with Reason
          </button>
          {isAdmin && (
            <button
              type="button"
              onClick={() => handleAction(ResultStatus.LOCKED)}
              disabled={selectedIds.length === 0 || isProcessing}
              className="min-h-11 px-4 py-2 rounded-lg text-sm font-medium bg-gray-800 hover:bg-gray-900 text-white dark:bg-gray-700 dark:hover:bg-gray-600 transition disabled:opacity-50"
            >
              Lock Results
            </button>
          )}
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex items-center gap-2 border-b border-gray-200 dark:border-gray-800 pb-2 overflow-x-auto">
        {(["ALL", ResultStatus.SUBMITTED, ResultStatus.APPROVED, ResultStatus.PUBLISHED, ResultStatus.LOCKED] as const).map((status) => (
          <button
            key={status}
            type="button"
            onClick={() => {
              setFilter(status);
              setSelectedIds([]);
            }}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold uppercase tracking-wider transition ${
              filter === status
                ? "bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300"
                : "text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
            }`}
          >
            {status}
          </button>
        ))}
      </div>

      {/* Rejection Reason Modal */}
      {showRejectDialog && (
        <div className="p-4 rounded-xl border border-red-200 dark:border-red-900 bg-red-50/50 dark:bg-red-950/20 space-y-3">
          <h3 className="text-sm font-semibold text-red-900 dark:text-red-200">
            Specify reason for returning {selectedIds.length} result(s) to author:
          </h3>
          <textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="e.g. CA score breakdown requires moderator review..."
            rows={2}
            className="w-full p-2.5 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowRejectDialog(false)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!rejectReason.trim() || isProcessing}
              onClick={() => handleAction(ResultStatus.DRAFT, rejectReason)}
              className="px-4 py-1.5 rounded-lg text-xs font-semibold bg-red-600 hover:bg-red-700 text-white disabled:opacity-50"
            >
              Confirm Rejection
            </button>
          </div>
        </div>
      )}

      {/* Results Table */}
      <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
        <table className="w-full text-left border-collapse text-sm">
          <thead>
            <tr className="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 text-xs font-semibold uppercase text-gray-500 dark:text-gray-400">
              <th className="py-3 px-4 w-10">
                <input
                  type="checkbox"
                  checked={selectedIds.length === filteredItems.length && filteredItems.length > 0}
                  onChange={handleSelectAll}
                  className="rounded border-gray-300 text-indigo-600"
                />
              </th>
              <th className="py-3 px-4">Student</th>
              <th className="py-3 px-4">Subject</th>
              <th className="py-3 px-4 text-center">Score</th>
              <th className="py-3 px-4 text-center">Grade</th>
              <th className="py-3 px-4 text-right">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {filteredItems.map((item) => (
              <tr key={item.id} className="hover:bg-gray-50/50 dark:hover:bg-gray-800/30 transition">
                <td className="py-3 px-4">
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(item.id)}
                    onChange={() => handleToggleSelect(item.id)}
                    className="rounded border-gray-300 text-indigo-600"
                  />
                </td>
                <td className="py-3 px-4 font-medium text-gray-900 dark:text-gray-100">
                  {item.studentName}
                  <span className="block font-mono text-xs text-gray-400">{item.admissionNo}</span>
                </td>
                <td className="py-3 px-4 text-gray-700 dark:text-gray-300">{item.subjectName}</td>
                <td className="py-3 px-4 text-center font-bold text-gray-900 dark:text-gray-100">
                  {item.score} / {item.maxScore}
                </td>
                <td className="py-3 px-4 text-center">
                  <span className="px-2 py-0.5 rounded text-xs font-semibold bg-gray-100 dark:bg-gray-800">{item.gradeLetter ?? "—"}</span>
                </td>
                <td className="py-3 px-4 text-right">
                  <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200">
                    {item.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
