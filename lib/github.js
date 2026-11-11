#!/usr/bin/env node

const axios = require('axios');
const config = require('../config');

const GH_API = 'https://api.github.com';
const { token, owner, repo, workflow_id, branch } = config.github;

const ghHeaders = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
};

const triggerBuild = async (inputs) => {
    try {
        const beforeRes = await axios.get(
            `${GH_API}/repos/${owner}/${repo}/actions/runs?per_page=1&event=workflow_dispatch`,
            { headers: ghHeaders }
        );
        const latestBefore = beforeRes.data?.workflow_runs?.[0]?.id || 0;

        await axios.post(
            `${GH_API}/repos/${owner}/${repo}/actions/workflows/${workflow_id}/dispatches`,
            { ref: branch, inputs },
            { headers: ghHeaders }
        );

        await new Promise(r => setTimeout(r, 5000));

        for (let i = 0; i < 12; i++) {
            const runsRes = await axios.get(
                `${GH_API}/repos/${owner}/${repo}/actions/runs?per_page=5&event=workflow_dispatch`,
                { headers: ghHeaders }
            );
            const runs = runsRes.data?.workflow_runs || [];
            const newRun = runs.find(r => r.id > latestBefore);
            if (newRun) {
                return {
                    success: true,
                    data: {
                        run_id: newRun.id,
                        status: newRun.status,
                        html_url: newRun.html_url,
                        created_at: newRun.created_at
                    }
                };
            }
            await new Promise(r => setTimeout(r, 3000));
        }

        return { success: false, message: 'Gagal mendapatkan run ID setelah trigger.' };
    } catch (err) {
        return { success: false, message: err.response?.data?.message || err.message };
    }
};

const getBuildStatus = async (run_id) => {
    try {
        const res = await axios.get(
            `${GH_API}/repos/${owner}/${repo}/actions/runs/${run_id}`,
            { headers: ghHeaders }
        );
        const run = res.data;
        return {
            success: true,
            data: {
                run_id: run.id,
                status: run.status,
                conclusion: run.conclusion,
                html_url: run.html_url,
                created_at: run.created_at,
                updated_at: run.updated_at,
                run_duration_ms: run.updated_at && run.created_at
                    ? new Date(run.updated_at) - new Date(run.created_at)
                    : null
            }
        };
    } catch (err) {
        return { success: false, message: err.response?.data?.message || err.message };
    }
};

const getArtifacts = async (run_id) => {
    try {
        const res = await axios.get(
            `${GH_API}/repos/${owner}/${repo}/actions/runs/${run_id}/artifacts`,
            { headers: ghHeaders }
        );
        const artifacts = res.data?.artifacts || [];
        if (artifacts.length === 0) return { success: false, message: 'Artifact belum tersedia.' };
        return { success: true, data: artifacts };
    } catch (err) {
        return { success: false, message: err.response?.data?.message || err.message };
    }
};

const streamArtifact = async (artifact_id, res) => {
    try {
        const redirectRes = await axios.get(
            `${GH_API}/repos/${owner}/${repo}/actions/artifacts/${artifact_id}/zip`,
            { headers: ghHeaders, maxRedirects: 0, validateStatus: s => s === 302 || s === 200 }
        );

        const downloadUrl = redirectRes.headers?.location
            || redirectRes.request?.res?.responseUrl;

        if (!downloadUrl) return { success: false, message: 'URL download tidak ditemukan.' };

        const fileRes = await axios.get(downloadUrl, { responseType: 'stream' });

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="app_${artifact_id}.zip"`);
        if (fileRes.headers['content-length']) {
            res.setHeader('Content-Length', fileRes.headers['content-length']);
        }

        fileRes.data.pipe(res);
        return { success: true };
    } catch (err) {
        return { success: false, message: err.response?.data?.message || err.message };
    }
};

module.exports = { triggerBuild, getBuildStatus, getArtifacts, streamArtifact };
