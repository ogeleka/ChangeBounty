import { BrowserRouter, Route, Routes } from 'react-router-dom'
import CreateJob from '@/components/CreateJob'
import Dashboard from '@/components/Dashboard'
import Demo from '@/components/Demo'
import JobDetails from '@/components/JobDetails'
import Landing from '@/components/Landing'
import Layout from '@/components/Layout'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Landing />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="create" element={<CreateJob />} />
          <Route path="jobs/:id" element={<JobDetails />} />
          <Route path="demo" element={<Demo />} />
          <Route path="*" element={<Landing />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
